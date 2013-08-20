#!/usr/bin/env node
// -*- mode: js -*-
// Copyright 2012 Joyent, Inc.  All rights reserved.

var assert = require('assert-plus');
var bunyan = require('bunyan');
var exec = require('child_process').exec;
var fs = require('fs');
var getopt = require('posix-getopt');
var manta = require('manta');
var path = require('path');
var vasync = require('vasync');



///--- Globals

var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'moray_gc',
        stream: process.stdout
});
var REBALANCE_CONFIG = (process.env.REBALANCE_CONFIG ||
                        process.argv[2] ||
                        '/opt/smartdc/mako/etc/mako_rebalancer.config');
var MANTA_CLIENT = manta.createClientFromFileSync(REBALANCE_CONFIG, LOG);
var MANTA_USER = MANTA_CLIENT.user;
var REBALANCE_PATH_PREFIX = '/' + MANTA_USER + '/stor/manta_rebalance/do';

function readConfig(_, cb) {
        fs.readFile(REBALANCE_CONFIG, function (err, contents) {
                if (err) {
                        cb(err);
                        return;
                }
                try {
                        var cfg = JSON.parse(contents);
                } catch (e) {
                        cb(e, 'error parsing config');
                        return;
                }

                assert.object(cfg, 'cfg');
                assert.object(cfg.manta_storage_id, 'cfg.manta_storage_id');
                assert.object(cfg.moray, 'cfg.moray');
                assert.string(cfg.moray.host, 'cfg.moray.host');
                assert.number(cfg.moray.port, 'cfg.moray.port');
                assert.number(cfg.moray.port, 'cfg.moray.connectTimeout');
                _.cfg = cfg;
                cb();
        });
}

vasync.pipeline({
        funcs: [
                readConfig
        ]
}, function (err) {
        if (err && !err.ok) {
                LOG.fatal(err);
                process.exit(1);
        }
        LOG.debug('Done.');
});
