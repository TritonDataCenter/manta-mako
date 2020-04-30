/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Attempt to test concurrent MPU commits going on the same objects and that
 * everything is properly cleaned up. Unfortunately there is no way to guarantee
 * that these are all executing concurrently on the server, we can only hope
 * that they are.
 */

var test = require('@smaller/tap').test;
var mod_extsprintf = require('extsprintf');
var sprintf = mod_extsprintf.sprintf;
var mod_http = require('http');
var mod_crypto = require('crypto');
var mod_vasync = require('vasync');
var uuidv4 = require('uuid/v4');

var mod_common = require('./common.js');

var MPU_NCOMMITS = 25;
var MPU_NFILES = 10;
var MPU_MAX_SIZE = 5 * 1024 * 1024;
var MPU_COMMIT = {};
var MPU_MD5;

test('setup', function(t) {
    t.plan(0);
    mod_common.mpu_setup();

    MPU_COMMIT['version'] = 1;
    MPU_COMMIT['nbytes'] = 0;
    MPU_COMMIT['account'] = uuidv4();
    MPU_COMMIT['objectId'] = uuidv4();
    MPU_COMMIT['parts'] = [];
    t.comment(
        `account: ${MPU_COMMIT['account']}, ` +
            `object: ${MPU_COMMIT['objectId']}`
    );
    t.end();
});

test('stream temporary files', function(t) {
    var i, data, size, parts, indexes, md5, buf;

    data = [];
    parts = [];
    indexes = [];
    md5 = mod_crypto.createHash('md5');
    for (i = 0; i < MPU_NFILES; i++) {
        size = MPU_MAX_SIZE;
        MPU_COMMIT.nbytes += size;
        buf = mod_crypto.randomBytes(size);
        data.push(buf);
        md5.update(buf);
        indexes.push(i);
        parts.push(uuidv4());
    }
    MPU_COMMIT.parts = parts;
    MPU_MD5 = md5.digest('base64');

    mod_vasync.forEachParallel(
        {
            func: function(arg, callback) {
                var req, opts, defopts;

                defopts = mod_common.mpu_default_opts();
                opts = {};
                opts.host = defopts.host;
                opts.port = defopts.port;
                opts.method = 'PUT';
                opts.path = sprintf('/%s/%s', MPU_COMMIT.account, parts[arg]);
                req = mod_http.request(opts, function(res) {
                    t.equal(res.statusCode, 201);
                    res.resume();
                    callback(null);
                });

                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(err);
                });
                req.write(data[arg]);
                req.end();
            },
            inputs: indexes
        },
        function() {
            t.end();
        }
    );
});

test('issue concurrent mpu commits', function(t) {
    var opts, inputs, i;

    opts = mod_common.mpu_default_opts();
    opts['agent'] = false;
    inputs = [];
    for (i = 0; i < MPU_NCOMMITS; i++) {
        inputs.push(opts);
    }

    mod_vasync.forEachParallel(
        {
            func: function(_, callback) {
                var req = mod_http.request(opts, function(res) {
                    t.equal(res.statusCode, 204);
                    t.equal(
                        res.headers['x-joyent-computed-content-md5'],
                        MPU_MD5
                    );
                    res.resume();
                    callback(null);
                });
                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(null);
                });
                req.write(JSON.stringify(MPU_COMMIT));
                req.end();
            },
            inputs: inputs
        },
        function() {
            t.end();
        }
    );
});

test('verify temporary files are removed', function(t) {
    mod_vasync.forEachParallel(
        {
            func: function(arg, callback) {
                var req, opts;

                opts = mod_common.mako_default_opts();
                opts.method = 'GET';
                opts.path = sprintf('/%s/%s', MPU_COMMIT['account'], arg);
                req = mod_http.request(opts, function(res) {
                    t.ok(res.statusCode, 404);
                    res.resume();
                    callback(null);
                });

                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(err);
                });
                req.end();
            },
            inputs: MPU_COMMIT['parts']
        },
        function() {
            t.end();
        }
    );
});

test('verify md5 on GET', function(t) {
    var req, opts;
    opts = mod_common.mako_default_opts();
    opts.method = 'GET';
    opts.path = sprintf(
        '/%s/%s',
        MPU_COMMIT['account'],
        MPU_COMMIT['objectId']
    );

    req = mod_http.request(opts, function(res) {
        var md5;
        t.ok(res.statusCode, 200);
        if (res.statusCode !== 200) {
            t.end();
            return;
        }

        md5 = mod_crypto.createHash('md5');
        res.on('data', function(buf) {
            md5.update(buf);
        });

        res.on('end', function() {
            t.equal(md5.digest('base64'), MPU_MD5);
            t.end();
        });
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });
    req.end();
});
