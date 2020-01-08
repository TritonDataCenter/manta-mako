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
 */

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');
var vasync = require('vasync');

var CONFIG_FILE = '/opt/smartdc/mako/etc/gc_config.json';
var DEFAULT_BAD_INSTRUCTION_DIR = '/manta/manta_gc/bad_instructions';
var DEFAULT_CONCURRENT_DELETES = 10;
var DEFAULT_INSTRUCTION_DIR = '/manta/manta_gc/instructions';
var DEFAULT_MAX_RUN_WAIT = 10000;
var DEFAULT_MIN_RUN_FREQ = 1000;
var SERVICE_NAME = 'garbage-deleter';
var MANTA_ROOT = '/manta';
var METRICS_SERVER_PORT = 8881;
var NS_PER_SEC = 1e9;


function GarbageDeleter(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.badInstructionDir, 'opts.badInstructionDir');
    assert.string(opts.concurrentDeletes, 'opts.concurrentDeletes');
    assert.optionalString(opts.instructionDir, 'opts.instructionDir');
    assert.optionalNumber(opts.maxRunWait, 'opts.maxRunWait');
    assert.optionalNumber(opts.minRunFreq, 'opts.minRunFreq');

    self.log = opts.log;

    self.badInstructionDir = opts.badInstructionDir;
    self.concurrentDeletes = opts.concurrentDeletes || DEFAULT_CONCURRENT_DELETES;
    self.instructionDir = opts.instructionDir;
    self.maxRunWait = opts.maxRunWait || DEFAULT_MAX_RUN_WAIT;
    self.minRunFreq = opts.minRunFreq || DEFAULT_MIN_RUN_FREQ;

    self.lastRun = 0;
    self.nextRunTimer = null;
    self.runningAsap = false;
}

GarbageDeleter.prototype.processFile =
function processFile(instrFile, callback) {
    var self = this;

    var badInstructions = 0;
    var beginning = process.hrtime();
    var filename = path.join(self.instructionDir, instrFile);

    if (!filename.match(/\.instruction$/)) {
        self.log.warn({
            filename: filename
        }, 'Ignoring non-instruction file.');
        callback();
        return;
    }

    self.log.info({filename: filename}, 'Processing file');

    // XXX Do we have problems if the file is too large?
    fs.readFile(filename, function _onReadFile(err, data) {
        var lines;
        var strData;

        strData = data.toString('utf8').trim();

        if (err) {
            self.log.error({
                err: err,
                filename: filename
            }, 'Failed to read instruction file.');
            callback(err);
            return;
        }

        lines = strData.split(/\n/);

        forEachParallel({
            concurrency: self.concurrentDeletes,
            func: function _runInstructions(line, cb) {
                var beginDelete = process.hrtime();
                var deleteFile;
                var fields = line.split(/\t/);

                self.log.trace({
                    fields: fields,
                    line: line
                }, 'Split line into fields.');

                if (fields.length !== 5) {
                    self.log.error({
                        fields: fields,
                        line: line
                    }, 'BAD NUMBER OF FIELDS !== 5');

                    badInstructions++;

                    cb(new Error('File "' + instrFile + '" has invalid number' +
                        ' of fields ' + fields.length + ' !== 5'));
                    return;
                }

                // TODO ASSERT That:
                //
                //  fields[0] is our storageId
                //  fields[1] is a uuid (creator UUID)
                //  fields[2] is a uuid (object UUID)
                //  fields[4] is a number (size)

                deleteFile = path.join(MANTA_ROOT, fields[1], fields[2]);

                self.log.trace('Deleting file "%s".', deleteFile);

                fs.unlink(deleteFile, function _unlinkMantaFile(unlinkErr) {
                    //
                    // TODO elapsed needs to be a metric
                    //
                    //     * histogram?
                    //     * counter?
                    //     * max, min?
                    //
                    self.log.trace({
                        creatorId: fields[1],
                        elapsed: elapsedSince(beginDelete),
                        err: unlinkErr,
                        filename: deleteFile,
                        objectId: fields[2]
                    }, 'Deleted one object.');

                    if (unlinkErr) {
                        if (unlinkErr.code === 'ENOENT') {
                            self.log.debug({
                                filename: deleteFile
                            }, 'File did not exist. Skipping.');
                        } else {
                            cb(unlinkErr);
                            return;
                        }
                    }

                    cb();
                });
            },
            inputs: lines
        }, function _ranInstructions(vasyncErr) {
            self.log.info({
                elapsed: elapsedSince(beginning),
                filename: filename
            }, 'Ran instructions.');

            if (badInstructions > 0) {
                // TODO: move to BAD_INSTRUCTIONS_DIR
                self.log.error('TODO: move to BAD_INSTRUCTIONS_DIR');
                // Should also call callback and return?
            }

            if (vasyncErr) {
                callback(vasyncErr);
                return;
            }

            // No error, so delete the instruction file.
            fs.unlink(filename, function _onUnlinkInstructionFile(e) {
                if (e) {
                    if (e.code !== 'ENOENT') {
                        callback(e);
                        return;
                    }
                    self.log.debug('Went to delete "%s" but did not exist',
                        filename);
                }
                callback();
            });
        });
    });
};


GarbageDeleter.prototype.run = function run(callback) {
    var self = this;

    var beginning = process.hrtime();

    self.log.trace('Running Deleter.');

    fs.readdir(self.instructionDir, function _onReaddir(err, files) {
        vasync.forEachParallel({
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
                fs.watch(self.instructionDir, function _onEvent() {
                    self.log.trace('Saw event on "%s".', self.instructionDir);
                    self.runAsap();
                });
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

                // TODO: setup other metrics

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
