/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test basic MPU construction.
 */

var test = require('@smaller/tap').test;
var mod_extsprintf = require('extsprintf');
var sprintf = mod_extsprintf.sprintf;
var mod_http = require('http');
var mod_crypto = require('crypto');
var mod_vasync = require('vasync');
var mod_jsprim = require('jsprim');
var uuidv4 = require('uuid/v4');

var mod_common = require('./common.js');

var MPU_NFILES = 5;
var MPU_MAX_SIZE = 256;
var MPU_COMMIT = {};
var MPU_MD5;

/*
 * Submit a garbage value for the body length
 */
function mpu_send_bad_length(t) {
    var req, opts, body;

    body = mod_jsprim.deepCopy(MPU_COMMIT);
    body.nbytes--;
    opts = mod_common.mpu_default_opts();
    req = mod_http.request(opts, function(res) {
        t.equal(res.statusCode, 409);
        t.equal(res.headers['content-type'], 'application/json');
        t.ok(res.headers['content-length'] > 0, 'non-zero content length');
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write(JSON.stringify(body));
    req.end();
}

/*
 * Run a test which generates a bad md5 sum
 */
function mpu_send_bad_md5(t) {
    var req, opts, body, md5;

    body = mod_jsprim.deepCopy(MPU_COMMIT);
    md5 = mod_crypto.createHash('md5');
    md5.update('Son of a Submariner');
    body.md5 = md5.digest('base64');
    t.notEqual(body.md5, MPU_MD5);
    opts = mod_common.mpu_default_opts();
    req = mod_http.request(opts, function(res) {
        t.equal(res.statusCode, 469);
        t.equal(res.headers['content-type'], 'application/json');
        t.ok(res.headers['content-length'] > 0, 'non-zero content length');
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write(JSON.stringify(body));
    req.end();
}

test('setup', function(t) {
    t.plan(0);
    mod_common.mpu_setup();

    MPU_COMMIT['version'] = 1;
    MPU_COMMIT['nbytes'] = 0;
    MPU_COMMIT['account'] = uuidv4();
    MPU_COMMIT['objectId'] = uuidv4();
    MPU_COMMIT['parts'] = [];
    console.log(
        sprintf(
            '# account: %s, object: %s',
            MPU_COMMIT['account'],
            MPU_COMMIT['objectId']
        )
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
        size = Math.ceil(Math.random() * MPU_MAX_SIZE);
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

test('send mpu commit with bad size', mpu_send_bad_length);

test('send mpu commit with bad md5', mpu_send_bad_md5);

test('send mpu commit', function(t) {
    var req, opts;

    opts = mod_common.mpu_default_opts();
    req = mod_http.request(opts, function(res) {
        t.equal(res.statusCode, 204);
        t.equal(res.headers['x-joyent-computed-content-md5'], MPU_MD5);
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write(JSON.stringify(MPU_COMMIT));
    req.end();
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

test('send second mpu commit', function(t) {
    var req, opts;

    opts = mod_common.mpu_default_opts();
    req = mod_http.request(opts, function(res) {
        t.equal(res.statusCode, 204);
        t.equal(res.headers['x-joyent-computed-content-md5'], MPU_MD5);
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write(JSON.stringify(MPU_COMMIT));
    req.end();
});

test('send second mpu commit with md5', function(t) {
    var req, opts, body;

    body = mod_jsprim.deepCopy(MPU_COMMIT);
    body.md5 = MPU_MD5;
    opts = mod_common.mpu_default_opts();
    req = mod_http.request(opts, function(res) {
        t.equal(res.statusCode, 204);
        t.equal(res.headers['x-joyent-computed-content-md5'], MPU_MD5);
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write(JSON.stringify(body));
    req.end();
});

test('send second mpu commit with bad size', mpu_send_bad_length);

test('send second mpu commit with bad md5', mpu_send_bad_md5);

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
