/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

// XXX should we have a /manta/manta_gc/instructions
//     and /manta/manta_gc/bad_instructions
//     ?

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');
var vasync = require('vasync');

var CONFIG_FILE = '/opt/smartdc/mako/etc/gc_config.json';
var INSTRUCTION_DIR = '/manta/manta_gc';
var SERVICE_NAME = 'garbage-collector';
var MANTA_ROOT = '/manta';
var METRICS_SERVER_PORT = 8881;
var NS_PER_SEC = 1e9;


function GarbageCollector(opts) {
    var self = this;

    self.lastRun = 0;
    self.log = opts.log;
    self.maxRunWait = 10000;
    self.minRunFreq = 1000;
    self.nextRunTimer = null;
    self.runningAsap = false;
}


GarbageCollector.prototype.processFile = function processFile(instrFile, callback) {
    var self = this;

    var beginning = process.hrtime();
    var filename = path.join(INSTRUCTION_DIR, instrFile);

    self.log.info({file: filename}, 'Processing file');

    // XXX What about large files? Do we avoid those just becauseof the sizing,
    // or should we set a larger read size here?
    //
    // Or... Use readline instead? :thinking:
    fs.readFile(filename, function _onReadFile(err, data) {
        var fields;
        var idx;
        var lines;
        var strData;

        strData = data.toString('utf8').trim();

        self.log.info({err: err}, 'err');
        lines = strData.split(/\n/);

        vasync.forEachParallel({
            func: function _runInstructions(line, cb) {
                var beginDelete = process.hrtime();
                var deleteFile;
                var fields = line.split(/\t/);

                self.log.info({fields: fields}, 'fields');

                if (fields.length !== 5) {
                    self.log.error({fields: fields}, 'BAD NUMBER OF FIELDS !== 5');

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

                self.log.info('Will delete file "%s"', deleteFile);

                fs.unlink(deleteFile, function _unlinkMantaFile(err) {
                    // XXX elapsed needs to be a metric
                    self.log.info({
                        elapsed: elapsedSince(beginDelete),
                        err: err
                    }, 'deleted one file');

                    if (err) {
                        if (err.code === 'ENOENT') {
                            self.log.info({
                                file: deleteFile
                            }, 'File did not exist');
                        } else {
                            cb(err);
                            return;
                        }
                    }

                    cb();
                });
            },
            inputs: lines
        }, function _ranInstructions(err) {
            self.log.info({elapsed: elapsedSince(beginning), file: filename}, 'Ran instructions');

            if (err) {
                callback(err);
            } else {
                // No error, so delete the instruction file.
                fs.unlink(filename, function _onUnlinkInstructionFile(err) {
                    if (err) {
                        if (err == 'ENOENT') {
                            self.log.info('Went to delete "%s" but did not exist', filename);
                        } else {
                            callback(err);
                        }
                    } else {
                        callback();
                    }
                });
            }
        });
    });
};


GarbageCollector.prototype.run = function run(callback) {
    var self = this;

    var beginning = process.hrtime();

    self.log.info('Run');

    // Since we're running now, we're going to set the next run up so that we
    // make sure that we don't wait longer than maxRunWait ms between runs.
    if (self.nextRunTimer !== null) {
        clearTimeout(self.nextRunTimer);
    }
    self.nextRunTimer = setTimeout(self.run.bind(self), self.maxRunWait);
    self.runningAsap = false;

    fs.readdir(INSTRUCTION_DIR, function _onReaddir(err, files) {
        vasync.forEachParallel({
            func: self.processFile.bind(self),
            inputs: files
        }, function _processedInstructions(err) {
            self.log.info({elapsed: elapsedSince(beginning), err: err}, 'processed instructions');
        });
    });

};


GarbageCollector.prototype.start = function start(callback) {
    var self = this;

    vasync.pipeline({
        funcs: [
            function _setupWatcher(_, cb) {
                fs.watch(INSTRUCTION_DIR, function _onEvent() {
                    self.log.info('SAW EVENT');
                    self.runAsap();
                });
                cb();
            }, function _startFirstRun(_, cb) {
                self.runAsap();
                cb();
            }
        ]
    }, function _started(err) {
        self.log.info({err: err}, 'Started');
        if (callback) {
            callback();
        }
    });
};


GarbageCollector.prototype.runAsap = function runAsap() {
    var self = this;

    var nextRun;
    var now;

    self.log.info({runningAsap: self.runningAsap}, 'will run ASAP');

    if (self.runningAsap) {
        // We're already going to run asap, nothing further to do.
        return;
    }
    self.runningAsap = true;

    now = new Date().getTime();

    if ((now - self.lastRun) >= self.minRunFreq) {
        // It has been long enough, so we can just run immediately.
        self.log.info('setImmediate');
        setImmediate(self.run.bind(self));
    } else {
        // It hasn't been long enough, so we want to schedule the run for the
        // future.
        if (self.nextRunTimer !== null) {
            clearTimeout(self.nextRunTimer);
        }
        nextRun = (now - (self.minRunFreq + self.lastRun));
        self.log.info('setTimeout(%d)', nextRun);
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

    return logger;
}


function elapsedSince(beginning, prev) {
    var elapsed;
    var timeDelta;

    timeDelta = process.hrtime(beginning);
    elapsed = timeDelta[0] + (timeDelta[1] / NS_PER_SEC);

    if (prev) {
        elapsed -= prev;
    }

    return elapsed;
}


function loadConfig(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var parsed;

    if (!opts.config && !opts.filename) {
        opts.filename = CONFIG_FILE;
    }

    if (opts.filename) {
        opts.log.info(opts, 'loading config from file');

        fs.readFile(opts.filename, function _onReadFile(err, data) {
            if (!err) {
                //try {
                    parsed = JSON.parse(data.toString('utf8'));
                //} catch (e) {
                //}
            }
            callback(err, parsed);

            // done(new VE(err, 'loading file "%s"', ctx.ctx_cfgfile));
            return;

        });
    }
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
            }, function _loadConfig(ctx, cb) {
                // XXX load the config to ctx.config
                loadConfig({
                    log: logger
                }, function _loadedConfig(err, cfg) {
                    if (!err) {
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
            }, function _createCollector(ctx, cb) {
                var gc = new GarbageCollector({
                    config: ctx.config,
                    log: logger,
                    metricsManager: ctx.metricsManager
                });

                gc.start(cb);
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
