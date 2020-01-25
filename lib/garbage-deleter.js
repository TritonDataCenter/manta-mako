/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * The job of this program is to watch for "instructions" files in the
 * instruction file directory (/manta/manta_gc/instructions) and when new files
 * show up:
 *
 *  - read the file
 *  - parse each line as an 'instruction'
 *  - execute the instructions (delete the specified files)
 *  - delete the instruction file after all instructions have been executed
 *
 * See: https://github.com/joyent/manta-eng/tree/master/garbage for more
 * details.
 *
 * When an invalid instruction file is found, including:
 *
 *  - not having a .instruction suffix
 *  - containing a line longer than the max line length (default: 2048)
 *  - having more than the maximum number of lines (default: 1000)
 *  - having (any) improperly formatted instruction lines
 *
 * the file will be moved to the "bad_instructions" directory for debugging. If
 * the problem is fixed, the file(s) can be moved back into the instructions
 * directory and reprocessed.
 *
 * TODO (maybe):
 *
 *  - Put the instruction max length and lines in the manta application, so both
 *    garbage-collector and deleter know what the current max is?
 *
 */

var fs = require('fs');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var readline = require('readline');
var restify = require('restify');
var vasync = require('vasync');
var VError = require('verror').VError;

var CONFIG_FILE = '/opt/smartdc/mako/etc/gc_config.json';
var DEFAULT_BAD_INSTRUCTION_DIR = '/manta/manta_gc/bad_instructions';
var DEFAULT_CONCURRENT_DELETES = 10;
var DEFAULT_INSTRUCTION_DIR = '/manta/manta_gc/instructions';
var DEFAULT_MANTA_ROOT = '/manta';
var DEFAULT_MAX_LINE_LENGTH = 2048;
var DEFAULT_MAX_LINES = 1000;
var DEFAULT_MAX_RUN_WAIT = 10000;
var DEFAULT_MIN_RUN_FREQ = 1000;
var SERVICE_NAME = 'garbage-deleter';
var METRIC_PREFIX = 'gc_storage_';
var METRICS_SERVER_PORT = 8881;
var NS_PER_SEC = 1e9;
var QUEUE_CHECK_FREQ = 60000; // ms between checks for number of files in queue


// Helpers


//
// Return a Number of seconds elapsed between *now* and `beginning`. The
// `beginning` parameter must be a previous process.hrtime() result.
//
function elapsedSince(beginning) {
    var elapsed;
    var timeDelta;

    timeDelta = process.hrtime(beginning);
    elapsed = timeDelta[0] + (timeDelta[1] / NS_PER_SEC);

    return (elapsed);
}

//
// This does basically the same thing as vasync.forEachParallel, but allows for
// a 'concurrency' parameter to limit how many are being done at once.
//
function forEachParallel(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalNumber(opts.concurrency, 'opts.concurrency');
    assert.func(opts.func, 'opts.func');
    assert.array(opts.inputs, 'opts.inputs');
    assert.func(callback, 'callback');

    var concurrency = (opts.concurrency ? Math.floor(opts.concurrency) : 0);
    var error = null;
    var idx;
    var queue;
    var results = {
        ndone: 0,
        nerrors: 0,
        operations: [],
        successes: []
    };

    if (!concurrency) {
        // If they didn't want concurrency control, just give them the original
        // vasync.forEachParallel.
        vasync.forEachParallel(opts, callback);
        return;
    }

    // Tell node.js to use up to "concurrency" threads for IO so that our
    // deletes actually do happen in parallel. (Node's default is 4)
    process.env.UV_THREADPOOL_SIZE = concurrency;

    queue = vasync.queue(opts.func, concurrency);

    queue.on('end', function () {
        callback(error, results);
    });

    function doneOne(err, result) {
        var _status;

        results.ndone++;
        if (err) {
            results.nerrors++;
            _status = 'fail';
            // Yes this overwrites with the last error seen.
            error = err;
        } else {
            results.successes.push(result);
            _status = 'ok';
        }
        results.operations.push({
            func: opts.func,
            funcname: opts.func.name || '(anon)',
            'status': _status,
            err: err,
            result: result
        });
    }

    for (idx = 0; idx < opts.inputs.length; idx++) {
        queue.push(opts.inputs[idx], doneOne);
    }

    queue.close();
}


// GarbageDeleter


function GarbageDeleter(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.badInstructionDir, 'opts.badInstructionDir');
    assert.optionalNumber(opts.concurrentDeletes, 'opts.concurrentDeletes');
    assert.object(opts.config, 'opts.config');
    assert.string(opts.config.manta_storage_id, 'opts.config.manta_storage_id');
    assert.optionalString(opts.instructionDir, 'opts.instructionDir');
    assert.optionalString(opts.mantaRoot, 'opts.mantaRoot');
    assert.optionalNumber(opts.maxLineLength, 'opts.maxLineLength');
    assert.optionalNumber(opts.maxLines, 'opts.maxLines');
    assert.optionalNumber(opts.maxRunWait, 'opts.maxRunWait');
    assert.optionalObject(opts.metricsManager, 'opts.metricsManager');
    assert.optionalNumber(opts.minRunFreq, 'opts.minRunFreq');

    // Options that exist only for testing.
    assert.optionalFunc(opts._readdir, 'opts._readdir');
    assert.optionalFunc(opts._readFile, 'opts._readFile');
    assert.optionalFunc(opts._fsReadFile, 'opts._fsReadFile');
    assert.optionalFunc(opts._fsRename, 'opts._fsRename');
    assert.optionalFunc(opts._fsUnlink, 'opts._fsUnlink');
    assert.optionalFunc(opts._processFileHook, 'opts._processFileHook');

    self.log = opts.log;

    self.badInstructionDir = opts.badInstructionDir;
    self.concurrentDeletes = opts.concurrentDeletes || DEFAULT_CONCURRENT_DELETES;
    self.config = opts.config;
    self.instructionDir = opts.instructionDir;
    self.mantaRoot = opts.mantaRoot || DEFAULT_MANTA_ROOT;
    self.maxLineLength = opts.maxLineLength || DEFAULT_MAX_LINE_LENGTH;
    self.maxLines = opts.maxLines || DEFAULT_MAX_LINES;
    self.maxRunWait = opts.maxRunWait || DEFAULT_MAX_RUN_WAIT;
    self.metricsManager = opts.metricsManager;
    self.minRunFreq = opts.minRunFreq || DEFAULT_MIN_RUN_FREQ;
    self.storageId = opts.config.manta_storage_id;

    self.lastRun = 0;
    self.nextRunTimer = null;
    self.runningAsap = false;
    self.stopping = false;

    // Metrics
    if (self.metricsManager) {
        self.metrics = {
            deleteCountMissing: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'delete_missing_count_total',
                help: 'Counter incremented every time a delete is attempted ' +
                    'for a Manta object but the object did not exist on disk.'
            }),
            deleteCountTotal: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'delete_count_total',
                help: 'Counter incremented every time a Manta object is deleted'
            }),
            deleteErrorCount: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'delete_error_count_total',
                help: 'Counter incremented every time a delete is attempted ' +
                    'for a Manta object but the delete failed.'
            }),
            deleteTimeMaxSeconds: self.metricsManager.collector.gauge({
                name: METRIC_PREFIX + 'delete_time_max_seconds',
                help: 'Gauge of maximum time spent in fs.unlink() deleting a ' +
                    'single Manta object (slowest delete)'
            }),
            deleteTimeMinSeconds: self.metricsManager.collector.gauge({
                name: METRIC_PREFIX + 'delete_time_min_seconds',
                help: 'Gauge of minimum time spent in fs.unlink() deleting a ' +
                    'single Manta object (fastest delete)'
            }),
            deleteTimeSeconds: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'delete_time_seconds_total',
                help: 'Counter of total time spent in fs.unlink() deleting Manta' +
                    'objects'
            }),
            instructionFilesBad: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'instruction_files_bad_count_total',
                help: 'Counter incremented for each instruction file found to be ' +
                    'invalid'
            }),
            instructionFilesDeleted: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'instruction_files_deleted_count_total',
                help: 'Counter incremented for each instruction file deleted'
            }),
            instructionFilesProcessed: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'instruction_files_processed_count_total',
                help: 'Counter incremented for each instruction file processed'
            }),
            instructionLinesProcessed: self.metricsManager.collector.counter({
                name: METRIC_PREFIX + 'instruction_lines_processed_count_total',
                help: 'Counter incremented for each instruction line processed'
            }),
            instructionFilesQueued: self.metricsManager.collector.gauge({
                name: METRIC_PREFIX + 'instruction_files_queued_count',
                help: 'Gauge indicating number of instructions files in queue'
            })
        };
    } else {
        self.metrics = {};
    }
    self.addCounter('deleteErrorCount', 0);
    self.addCounter('deleteCountTotal', 0);
    self.addCounter('deleteTimeSeconds', 0);
    self.addCounter('instructionFilesBad', 0);
    self.addCounter('instructionFilesDeleted', 0);
    self.addCounter('instructionFilesProcessed', 0);
    self.addCounter('instructionLinesProcessed', 0);
    self.setGauge('instructionFilesQueued', 0);

    // Add properties which should be modified only for testing purposes.
    self.fsCreateReadStream = opts._fsCreateReadStream || fs.createReadStream;
    self.fsReaddir = opts._fsReaddir || fs.readdir;
    self.fsReadFile = opts._fsReadFile || fs.readFile;
    self.fsRename = opts._fsRename || fs.rename;
    self.fsUnlink = opts._fsUnlink || fs.unlink;
    self.fsWatch = opts._fsWatch || fs.watch;
    if (opts._processFileHook) {
        self._processFileHook = opts._processFileHook;
    }
}

GarbageDeleter.prototype.addCounter = function addCounter(counterName, value) {
    var self = this;

    // For tests, we don't want to require a full metricManager, so in that case
    // we just manually manage the values in the "metrics" object.
    if (!self.metricsManager) {
        if (!self.metrics.hasOwnProperty(counterName)) {
            self.metrics[counterName] = 0;
        }
        self.metrics[counterName] += value;
        return;
    }

    self.metrics[counterName].add(value);
};

GarbageDeleter.prototype.getCounter = function getCounter(counterName) {
    var self = this;

    if (!self.metricsManager) {
        return self.metrics[counterName];
    }

    return self.metrics[counterName].getValue();
};

GarbageDeleter.prototype.getGauge = function getGauge(gaugeName) {
    var self = this;

    if (!self.metricsManager) {
        return self.metrics[gaugeName];
    }

    return self.metrics[gaugeName].getValue();
};

GarbageDeleter.prototype.setGauge = function setGauge(gaugeName, value) {
    var self = this;

    // For tests, we don't want to require a full metricManager, so in that case
    // we just manually manage the values in the "metrics" object.
    if (!self.metricsManager) {
        self.metrics[gaugeName] = value;
        return;
    }

    self.metrics[gaugeName].set(value);
};

GarbageDeleter.prototype.readLines = function readLines(filename, callback) {
    var self = this;

    var closing = false;
    var lineReader;
    var lines = [];
    var lineNum = 0;
    var readStream;

    readStream = self.fsCreateReadStream(filename, {
        encoding: 'utf8',
        end: (self.maxLineLength + 1) * self.maxLines,
        start: 0
    });

    lineReader = readline.createInterface({
        input: readStream,
        crlfDelay: Infinity
    });

    lineReader.on('line', function _onLine(line) {
        lineNum++;

        if (closing) {
            return;
        }

        if (line.length > self.maxLineLength) {
            closing = true;
            lineReader.close();

            callback(new VError({
                info: {
                    filename: filename,
                    lineNum: lineNum,
                    length: line.length,
                    maxLength: self.maxLineLength
                },
                name: 'LineTooLongError'
            }, util.format('Line %d too long: %d > %d',
                lineNum, line.length, self.maxLineLength)));

            return;
        }

        lines.push(line);
    });

    lineReader.on('close', function _onClose() {
        //
        // If we're closing intentionally, we hit an error so don't need to call
        // the callback. If we're closing because we hit the end of the file
        // without error, we do want to call the callback with the lines we
        // gathered.
        //
        if (!closing) {
            callback(null, lines);
        }
    });
};

//
// This function is called for each line of each otherwise valid instruction
// file. It is responsible for parsing the line, dispatching the delete and
// updating the related metrics.
//
GarbageDeleter.prototype.processInstruction =
function processInstruction(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.filename, 'opts.filename');
    assert.string(opts.instructionLine, 'opts.instructionLine');

    var beginDelete;
    var deleteFile;
    var fields;
    var filename = opts.filename;
    var instructionLine = opts.instructionLine;

    fields = instructionLine.split(/\t/);

    self.log.trace({
        fields: fields,
        line: instructionLine
    }, 'Split line into fields.');

    if (fields.length !== 5) {
        self.log.error({
            fields: fields,
            line: instructionLine
        }, 'Instruction line contains bad number of fields.');

        callback(new VError({
            info: {
                fields: fields,
                filename: filename,
                line: instructionLine
            },
            name: 'InvalidNumberOfFieldsError'
        }, 'File "' + path.basename(filename) + '" has invalid number' +
            ' of fields ' + fields.length + ' !== 5'));
        return;
    }

    self.addCounter('instructionLinesProcessed', 1);

    try {
        assert.equal(fields[0], self.storageId); // storageId
        assert.uuid(fields[1]);                  // creatorUuid
        assert.uuid(fields[2]);                  // objectUuid
        // fields[3] is the metadata shardId, not relevant here.
        assert.string(fields[4]);
        assert.ok(fields[4].match(/^[0-9]+$/));  // size
    } catch (e) {
        callback(new VError({
            cause: e,
            info: {
                fields: fields,
                filename: filename
            },
            name: 'InvalidInstructionError'
        }, 'Invalid instruction in ' + path.basename(filename) + ': ' +
            JSON.stringify(fields)));
        return;
    }

    deleteFile = path.join(self.mantaRoot, fields[1], fields[2]);

    self.log.trace('Deleting file "%s".', deleteFile);

    beginDelete = process.hrtime();
    self.fsUnlink(deleteFile, function _unlinkMantaFile(unlinkErr) {
        var curval;
        var elapsed = elapsedSince(beginDelete);

        self.log.trace({
            creatorId: fields[1],
            elapsed: elapsed,
            err: unlinkErr,
            filename: deleteFile,
            objectId: fields[2]
        }, 'Deleted one object.');

        self.addCounter('deleteCountTotal', 1);
        self.addCounter('deleteTimeSeconds', elapsed);
        curval = self.getGauge('deleteTimeMaxSeconds');
        if (curval === undefined || elapsed > curval) {
            self.setGauge('deleteTimeMaxSeconds', elapsed);
        }
        curval = self.getGauge('deleteTimeMinSeconds');
        if (curval === undefined || elapsed < curval) {
            self.setGauge('deleteTimeMinSeconds', elapsed);
        }

        if (unlinkErr) {
            if (unlinkErr.code === 'ENOENT') {
                self.log.debug({
                    filename: deleteFile
                }, 'File did not exist. Skipping.');
                self.addCounter('deleteCountMissing', 1);
            } else {
                callback(new VError({
                    cause: unlinkErr,
                    info: {
                        filename: deleteFile
                    },
                    name: 'UnlinkFileError'
                }, 'Failed to delete file.'));
                self.addCounter('deleteErrorCount', 1);
                return;
            }
        } else {
            self.addCounter('instructionFilesDeleted', 1);
        }

        callback();
    });

};

GarbageDeleter.prototype.processFile =
function processFile(instrFile, callback) {
    var self = this;

    var badFilename = path.join(self.badInstructionDir, instrFile);
    var beginning = process.hrtime();
    var filename = path.join(self.instructionDir, instrFile);
    var lineCount = 0;

    // We use this function so that we can add a hook for tests to be able to
    // know the result from each file that was processed.
    function _doneProcessing(err) {
        self.addCounter('instructionFilesProcessed', 1);

        // On any error, we move the instruction file to the bad_instructions
        // directory.
        if (err) {
            self.addCounter('instructionFilesBad', 1);

            self.log.warn({
                errInfo: VError.info(err),
                filename: filename
            }, 'Failed to process file, moving to bad_instructions.');

            self.fsRename(filename, badFilename, function _onRename(renameErr) {
                if (renameErr) {
                    self.log.error({
                        err: renameErr,
                        srcFilename: filename,
                        targFilename: badFilename
                    }, 'Failed to rename file to bad_instructions.');
                }

                if (self._processFileHook) {
                    self._processFileHook({
                        err: err,
                        filename: instrFile,
                        lineCount: lineCount
                    });
                }

                // We don't return an error here because we don't want the
                // failure to remove one invalid instruction file to prevent
                // other files from being processed.
                callback();
            });
        } else {
            if (self._processFileHook) {
                self._processFileHook({
                    err: err,
                    filename: instrFile,
                    lineCount: lineCount
                });
            }

            callback();
        }
    }

    if (!filename.match(/\.instruction$/)) {
        self.log.warn({
            filename: filename
        }, 'Ignoring non-instruction file.');

        _doneProcessing(new VError({
            info: {
                filename: filename
            },
            name: 'MissingInstructionSuffixError'
        }, 'Filename missing .instruction suffix.'));

        return;
    }

    self.log.info({filename: filename}, 'Processing file.');

    self.readLines(filename, function _onReadFile(err, lines) {
        if (err) {
            self.log.error({err: err}, 'Error reading lines.');
            _doneProcessing(err);
            return;
        }

        lineCount = lines.length;

        if (lineCount === 0) {
            _doneProcessing(new VError({
                info: {
                    filename: filename
                },
                name: 'EmptyFileError'
            }, 'Instruction file is empty.'));
            return;
        }

        if (lineCount > self.maxLines) {
            _doneProcessing(new VError({
                info: {
                    filename: filename,
                    lines: lineCount,
                    maxLines: self.maxLines
                },
                name: 'TooManyLinesError'
            }, 'Instruction file contains too many lines.'));
            return;
        }

        // At this point we know the file has > 0 and < self.maxLines lines of
        // instructions. So we'll process up to self.concurrentDeletes of the
        // lines at a time.

        forEachParallel({
            concurrency: self.concurrentDeletes,
            func: function _runInstructions(line, cb) {
                self.processInstruction({
                    filename: filename,
                    instructionLine: line
                }, cb);
            },
            inputs: lines
        }, function _ranInstructions(parallelErr, results) {
            self.log.info({
                elapsed: elapsedSince(beginning),
                filename: filename
            }, 'Ran instructions.');

            if (parallelErr) {
                _doneProcessing(parallelErr);
                return;
            }

            // No error, so delete the instruction file.
            self.fsUnlink(filename, function _onUnlinkInstructionFile(e) {
                if (e) {
                    if (e.code !== 'ENOENT') {
                        _doneProcessing(e);
                        return;
                    }
                    self.log.debug('Went to delete "%s" but did not exist',
                        filename);
                }
                _doneProcessing();
            });
        });
    });
};

GarbageDeleter.prototype.run = function run() {
    var self = this;

    var beginning = process.hrtime();

    if (self.stopping) {
        self.log.trace('Not running Deleter, stopping in progress.');
        return;
    }

    self.log.trace('Running Deleter.');

    self.fsReaddir(self.instructionDir, function _onReaddir(err, files) {
        // We serially process files, but process the instructions inside the
        // files in parallel with a concurrency limit. This prevents us from
        // having to worry about tuning multiple knobs.
        vasync.forEachPipeline({
            func: self.processFile.bind(self),
            inputs: files
        }, function _processedInstructions(e) {
            self.log.info({
                elapsed: elapsedSince(beginning),
                err: e
            }, 'Processed all instructions.');

            //
            // Since we just ran now, we're going to set the next run up so that
            // we make sure that we don't wait longer than maxRunWait ms between
            // runs.
            //
            if (self.nextRunTimer !== null) {
                clearTimeout(self.nextRunTimer);
            }

            // If we're stopping, we don't want to run again.
            if (self.stopping) {
                return;
            }

            self.nextRunTimer =
                setTimeout(self.run.bind(self), self.maxRunWait);
            self.runningAsap = false;
        });
    });

};

GarbageDeleter.prototype.start = function start(callback) {
    var self = this;

    vasync.pipeline({
        funcs: [
            function _setupWatcher(_, cb) {
                self.fsWatcher = self.fsWatch(self.instructionDir, function _onEvent() {
                    self.log.trace('Saw event on "%s".', self.instructionDir);
                    self.runAsap();
                });
                cb();
            }, function _startQueueMonitor(_, cb) {
                self.countQueue();
                cb();
            }, function _startFirstRun(_, cb) {
                self.runAsap();
                cb();
            }
        ]
    }, function _started(err) {
        self.log.trace({err: err}, 'Started.');
        if (callback) {
            callback();
        }
    });
};

GarbageDeleter.prototype.stop = function stop(callback) {
    var self = this;

    assert.optionalFunc(callback, 'callback');

    self.stopping = true;

    self.log.trace('Clearing next run timer.');
    clearTimeout(self.nextRunTimer);

    if (self.fsWatcher) {
        self.log.trace('Stopping fsWatcher.');
        self.fsWatcher.close();
        self.fsWatcher = null;
    }

    self.runningAsap = false;

    self.log.trace('Clearing queue counter timer.');
    clearTimeout(self.queueCounterTimer);

    self.log.trace('Stopped.');

    if (callback) {
        callback();
    }
};

GarbageDeleter.prototype.runAsap = function runAsap() {
    var self = this;

    var nextRun;
    var now;

    self.log.trace({
        runningAsap: self.runningAsap
    }, 'Will run again ASAP.');

    if (self.runningAsap) {
        // We're already going to run asap, nothing further to do.
        return;
    }
    self.runningAsap = true;

    now = new Date().getTime();

    if ((now - self.lastRun) >= self.minRunFreq) {
        // It has been long enough, so we can just run immediately.
        setImmediate(self.run.bind(self));
    } else {
        // It hasn't been long enough, so we want to schedule the run for the
        // future.
        if (self.nextRunTimer !== null) {
            clearTimeout(self.nextRunTimer);
        }
        nextRun = (now - (self.minRunFreq + self.lastRun));
        self.log.trace('setTimeout(self.run, %d)', nextRun);
        self.nextRunTimer = setTimeout(self.run.bind(self), nextRun);
    }
};

//
// This simply counts how many instructions files are in the instruction dir,
// updates the metric, and then schedules the next check.
//
GarbageDeleter.prototype.countQueue = function countQueue() {
    var self = this;

    self.fsReaddir(self.instructionDir, function _onReaddir(err, files) {
        if (!err) {
            self.setGauge('instructionFilesQueued', files.length);
        } else {
            self.log.warn({
                dir: self.instructionDir,
                err: err
            }, 'Failed to read instruction dir to count files.');
        }

        if (self.stopping) {
            return;
        }

        // schedule next check
        self.queueCounterTimer = setTimeout(self.countQueue.bind(self),
            QUEUE_CHECK_FREQ);
    });
};


// Main program


function createLogger(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');

    var logger = bunyan.createLogger({
        level: opts.level || process.env.LOG_LEVEL || bunyan.INFO,
        name: opts.name,
        serializers: bunyan.stdSerializers
    });

    return (logger);
}

//
// Try to load the config file opts.filename (optional, default: CONFIG_FILE)
// call callback(err, obj) with the parsed configuration as `obj` on success or
// an Error object as `err` on failure.
//
function loadConfig(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var parsed = {};

    if (!opts.config && !opts.filename) {
        opts.filename = CONFIG_FILE;
    }

    if (!opts.filename) {
        callback(null, parsed);
        return;
    }

    opts.log.trace(opts, 'Loading config from file.');

    fs.readFile(opts.filename, function _onReadFile(err, data) {
        if (!err) {
            try {
                parsed = JSON.parse(data.toString('utf8'));
            } catch (e) {
                callback(e);
                return;
            }
        }

        callback(err, parsed);
        return;
    });
}

function main() {
    var BAD_INSTRUCTION_DIR = DEFAULT_BAD_INSTRUCTION_DIR;
    var beginning;
    var INSTRUCTION_DIR = DEFAULT_INSTRUCTION_DIR;
    var logger;

    beginning = process.hrtime();

    vasync.pipeline({
        arg: {},
        funcs: [
            function _createLogger(_, cb) {
                logger = createLogger({
                    level: 'trace', // XXX temporary
                    name: SERVICE_NAME
                });

                cb();
            }, function _waitDir(_, cb) {
                var dirExists = false;

                //
                // The INSTRUCTION_DIR will be created automatically (by nginx)
                // when the first instructions come in. Until that point,
                // there'll be nothing to do. We don't create the directory
                // ourselves since we want nginx to create it with the correct
                // permissions. So we just wait for the directory to exist.
                //
                function _checkDir(_cb) {
                    fs.stat(INSTRUCTION_DIR, function _stat(err, stats) {
                        if (err && err.code !== 'ENOENT') {
                            // Unexpected error
                            _cb(err);
                            return;
                        } else if (!err && stats.isDirectory()) {
                            dirExists = true;
                        }

                        _cb();
                    });
                }

                _checkDir(function _onCheck(err) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    if (!dirExists) {
                        logger.info('Instruction dir "%s" missing, waiting ' +
                            'until it exists', INSTRUCTION_DIR);
                    }

                    //
                    // This will call _checkDir() every 1000ms (1 second) until
                    // the directory exists or there is an error then will call
                    // cb(err).
                    //
                    vasync.whilst(function _checkExists() {
                        return (!dirExists);
                    }, function _checkAgain(_cb) {
                        logger.debug('Dir "%s" still does not exist, waiting.',
                            INSTRUCTION_DIR);
                        setTimeout(_checkDir, 1000, _cb);
                    }, function _doneWaiting(e) {
                        if (!e) {
                            logger.info('Instruction dir "%s" exists.',
                                INSTRUCTION_DIR);
                        }
                        cb(e);
                    });
                });
            }, function _makeBadInstructionDir(_, cb) {
                fs.mkdir(BAD_INSTRUCTION_DIR, function _onMkdir(err) {
                    if (err && err.code !== 'EEXIST') {
                         logger.error('Unable to create dir "' +
                             BAD_INSTRUCTION_DIR + '": ' + err.message);
                         cb(err);
                         return;
                    }

                    cb();
                });
            }, function _loadConfig(ctx, cb) {
                loadConfig({
                    log: logger
                }, function _loadedConfig(err, cfg) {
                    if (!err) {
                        logger.trace({
                            cfg: cfg
                        }, 'Loaded config.');
                        ctx.config = cfg;
                    }

                    //
                    // Validate the config:
                    //
                    // config-agent should have ensured these are set in our
                    // config, we'll just blow up if they're not.
                    //
                    assert.string(ctx.config.admin_ip, 'config.admin_ip');
                    assert.string(ctx.config.datacenter, 'config.datacenter');
                    assert.uuid(ctx.config.instance, 'config.instance');
                    assert.string(ctx.config.manta_storage_id,
                        'config.manta_storage_id');
                    assert.uuid(ctx.config.server_uuid, 'config.server_uuid');

                    cb(err);
                });

            }, function _setupMetrics(ctx, cb) {
                var metricsManager = createMetricsManager({
                    address: ctx.config.admin_ip,
                    log: logger,
                    staticLabels: {
                        datacenter: ctx.config.datacenter,
                        instance: ctx.config.instance,
                        server: ctx.config.server_uuid,
                        service: SERVICE_NAME
                    },
                    port: METRICS_SERVER_PORT,
                    restify: restify
                });
                metricsManager.createNodejsMetrics();
                metricsManager.listen(cb);
                ctx.metricsManager = metricsManager;
            }, function _createDeleter(ctx, cb) {
                var gd = new GarbageDeleter({
                    badInstructionDir: BAD_INSTRUCTION_DIR,
                    config: ctx.config,
                    instructionDir: INSTRUCTION_DIR,
                    log: logger,
                    metricsManager: ctx.metricsManager
                });

                gd.start(cb);
            }
        ]
    }, function _doneMain(err) {
        logger.info({
            elapsed: elapsedSince(beginning),
            err: err
        }, 'Startup complete.');
    });
}

if (require.main === module) {
    main();
}

module.exports = GarbageDeleter;
