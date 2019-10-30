/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var fs = require('fs');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');
var vasync = require('vasync');

var CONFIG_FILE = '/opt/smartdc/manta-garbage-collector/etc/config.json';
var INSTRUCTION_DIR = '/manta/manta_gc';
var SERVICE_NAME = 'garbage-collector';
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


GarbageCollector.prototype.start = function start() {
    var self = this;

    vasync.pipeline({
        funcs: [
            function _setupWatcher(_, cb) {
                fs.watch(INSTRUCTION_DIR, function _onEvent() {
                    self.log.info('SAW EVENT');
                    self.runAsap();
                });
                cb();
            }, function _startTimer(_, cb) {
                self.scheduleFallback(self.maxRunWait);
                cb();
            }, function _startFirstRun(_, cb) {
                self.runAsap();
                cb();
            }
        ]
    }, function _started(err) {
        self.log.info({err: err}, 'Started');
    });
};


GarbageCollector.prototype.runAsap = function runAsap() {
    var self = this;

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
        setImmediate(self.run);
    } else {
        // It hasn't been long enough, so we want to schedule the run for the
        // future.
        if (self.nextRunTimer !== null) {
            clearTimeout(self.nextRunTimer);
        }
        self.nextRunTimer = setTimeout(self.run, (now - self.lastRun));
    }
};


GarbageCollector.prototype.run = function run(callback) {
    var self = this;

    // Since we're running now, we're going to set the next run up so that we
    // make sure that we don't wait longer than maxRunWait ms between runs.
    if (self.nextRunTimer !== null) {
        clearTimeout(self.nextRunTimer);
    }
    self.nextRunTimer = setTimeout(self.run, self.maxRunWait);

    self.log.info('RUNNING');
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
