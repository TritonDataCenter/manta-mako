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

var assert = require('assert-plus');
var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');
var vasync = require('vasync');

var common = require('lib/common');
var GarbageDeleter = require('lib/garbage-deleter');

var elapsedSince = common.elapsedSince;

var CONFIG_FILE = '/opt/smartdc/mako/etc/gc_config.json';
var DEFAULT_BAD_INSTRUCTION_DIR = '/manta/manta_gc/bad_instructions';
var DEFAULT_INSTRUCTION_DIR = '/manta/manta_gc/instructions';
var SERVICE_NAME = 'garbage-deleter';
var METRICS_SERVER_PORT = 8881;

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

    vasync.pipeline(
        {
            arg: {},
            funcs: [
                function _createLogger(_, cb) {
                    logger = createLogger({
                        level: 'trace', // XXX temporary
                        name: SERVICE_NAME
                    });

                    cb();
                },
                function _waitDir(_, cb) {
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
                            logger.info(
                                'Instruction dir "%s" missing, waiting ' +
                                    'until it exists',
                                INSTRUCTION_DIR
                            );
                        }

                        //
                        // This will call _checkDir() every 1000ms (1 second) until
                        // the directory exists or there is an error then will call
                        // cb(err).
                        //
                        vasync.whilst(
                            function _checkExists() {
                                return !dirExists;
                            },
                            function _checkAgain(_cb) {
                                logger.debug(
                                    'Dir "%s" still does not exist, waiting.',
                                    INSTRUCTION_DIR
                                );
                                setTimeout(_checkDir, 1000, _cb);
                            },
                            function _doneWaiting(e) {
                                if (!e) {
                                    logger.info(
                                        'Instruction dir "%s" exists.',
                                        INSTRUCTION_DIR
                                    );
                                }
                                cb(e);
                            }
                        );
                    });
                },
                function _makeBadInstructionDir(_, cb) {
                    fs.mkdir(BAD_INSTRUCTION_DIR, function _onMkdir(err) {
                        if (err && err.code !== 'EEXIST') {
                            logger.error(
                                'Unable to create dir "' +
                                    BAD_INSTRUCTION_DIR +
                                    '": ' +
                                    err.message
                            );
                            cb(err);
                            return;
                        }

                        cb();
                    });
                },
                function _loadConfig(ctx, cb) {
                    loadConfig(
                        {
                            log: logger
                        },
                        function _loadedConfig(err, cfg) {
                            if (!err) {
                                logger.trace(
                                    {
                                        cfg: cfg
                                    },
                                    'Loaded config.'
                                );
                                ctx.config = cfg;
                            }

                            //
                            // Validate the config:
                            //
                            // config-agent should have ensured these are set in our
                            // config, we'll just blow up if they're not.
                            //
                            assert.string(
                                ctx.config.admin_ip,
                                'config.admin_ip'
                            );
                            assert.string(
                                ctx.config.datacenter,
                                'config.datacenter'
                            );
                            assert.uuid(ctx.config.instance, 'config.instance');
                            assert.string(
                                ctx.config.manta_storage_id,
                                'config.manta_storage_id'
                            );
                            assert.uuid(
                                ctx.config.server_uuid,
                                'config.server_uuid'
                            );

                            cb(err);
                        }
                    );
                },
                function _setupMetrics(ctx, cb) {
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
                },
                function _createDeleter(ctx, cb) {
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
        },
        function _doneMain(err) {
            logger.info(
                {
                    elapsed: elapsedSince(beginning),
                    err: err
                },
                'Startup complete.'
            );
        }
    );
}

main();
