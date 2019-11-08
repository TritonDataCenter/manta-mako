/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

// XXX should we have /manta/manta_gc/bad_instructions?

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');
var vasync = require('vasync');

var CONFIG_FILE = '/opt/smartdc/mako/etc/gc_config.json';
var INSTRUCTION_DIR = '/manta/manta_gc/instructions';
var SERVICE_NAME = 'garbage-deleter';
var MANTA_ROOT = '/manta';
var METRICS_SERVER_PORT = 8881;
var NS_PER_SEC = 1e9;


function GarbageDeleter(opts) {
    var self = this;

    self.lastRun = 0;
    self.log = opts.log;
    self.maxRunWait = 10000;
    self.minRunFreq = 1000;
    self.nextRunTimer = null;
    self.runningAsap = false;
}


GarbageDeleter.prototype.processFile =
function processFile(instrFile, callback) {
    var self = this;

    var beginning = process.hrtime();
    var filename = path.join(INSTRUCTION_DIR, instrFile);

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

        // XXX we can't concurrency here. :( Maybe we need to use a queue?
        vasync.forEachParallel({
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

                    // XXX error should include filename and fields
                    cb(new Error('Bad number of fields'));
                    return;
                }

                // ASSERT That:
                //
                //  fields[0] is our storageId
                //  fields[1] is a uuid (creator UUID)
                //  fields[2] is a uuid (object UUID)
                //  fields[4] is a number (size)

                deleteFile = path.join(MANTA_ROOT, fields[1], fields[2]);

                self.log.trace('Deleting file "%s".', deleteFile);

                fs.unlink(deleteFile, function _unlinkMantaFile(unlinkErr) {
                    //
                    // XXX elapsed needs to be a metric
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

    fs.readdir(INSTRUCTION_DIR, function _onReaddir(err, files) {
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
                fs.watch(INSTRUCTION_DIR, function _onEvent() {
                    self.log.trace('Saw event on "%s".', INSTRUCTION_DIR);
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


function elapsedSince(beginning, prev) {
    var elapsed;
    var timeDelta;

    timeDelta = process.hrtime(beginning);
    elapsed = timeDelta[0] + (timeDelta[1] / NS_PER_SEC);

    if (prev) {
        elapsed -= prev;
    }

    return (elapsed);
}


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
    var beginning;
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

            }, function _loadConfig(ctx, cb) {
                // XXX load the config to ctx.config
                loadConfig({
                    log: logger
                }, function _loadedConfig(err, cfg) {
                    if (!err) {
                        logger.trace({
                            cfg: cfg
                        }, 'Loaded config.');
                        ctx.config = cfg;
                    }
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
                    config: ctx.config,
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

main();
