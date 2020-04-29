/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Test basic MPU validation (generally error cases)
 */

var test = require('@smaller/tap').test;
var mod_extsprintf = require('extsprintf');
var sprintf = mod_extsprintf.sprintf;
var mod_vasync = require('vasync');
var mod_http = require('http');
var mod_crypto = require('crypto');
var mod_jsprim = require('jsprim');
var mod_common = require('./common.js');

/*
 * Almost all errors, with the exception of memory errors, should have a
 * non-zero content-length and an encoding of JSON.
 */
function mpu_correct_error_headers(t, res) {
    t.equal(res.headers['content-type'], 'application/json');
    t.ok(res.headers['content-length'] > 0, 'non-zero content length');
}

/*
 * Constructs a basic MPU commit payload whose types and values are roughly
 * correct, but doesn't correspond to real files.
 */
function mpu_basic_bad_payload() {
    var payload = {};
    payload['version'] = 1;
    payload['nbytes'] = 3;
    payload['account'] = 'kefka';
    payload['objectId'] = 'gestahl';
    payload['parts'] = ['maduin'];

    return payload;
}

/*
 * Given a payload, verifies that it returns a 400.
 */
function mpu_bad_payload(payload, t) {
    var req;

    req = mod_http.request(mod_common.mpu_default_opts(), function(res) {
        t.equal(res.statusCode, 400);
        mpu_correct_error_headers(t, res);
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });
    req.write(JSON.stringify(payload));

    req.end();
}

test('setup', function(t) {
    mod_common.mpu_setup();
    t.end();
});

/*
 * Verify that the following methods aren't permitted on the MPU endpoint.
 */
test('bad methods on commit API', function(t) {
    mod_vasync.forEachParallel(
        {
            func: function(arg, callback) {
                var req;
                var opts;
                opts = mod_common.mpu_default_opts();
                opts['method'] = arg;

                req = mod_http.request(opts, function(res) {
                    t.equal(res.statusCode, 405);
                    res.resume();
                    callback(null);
                });

                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(err);
                });

                req.end();
            },
            inputs: ['GET', 'PUT', 'DELETE']
        },
        function() {
            t.end();
        }
    );
});

/*
 * Verify that a 1 MiB chunk of data is rejected, we should have a limit around
 * 512 KiB.
 */
test('large body is rejected', function(t) {
    var req;
    req = mod_http.request(mod_common.mpu_default_opts(), function(res) {
        t.equal(res.statusCode, 413);
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write(mod_crypto.randomBytes(1024 * 1024));
    req.end();
});

/*
 * Verify that if we send random data, it does not crash the server and does not
 * end up parsing as JSON.
 */
test('invalid json, random data', function(t) {
    mod_vasync.forEachParallel(
        {
            func: function(arg, callback) {
                var req, data, opts;

                data = mod_crypto.randomBytes(arg);
                opts = mod_common.mpu_default_opts();
                req = mod_http.request(opts, function(res) {
                    t.equal(res.statusCode, 400);
                    mpu_correct_error_headers(t, res);
                    res.resume();
                    callback(null);
                });

                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(err);
                });
                req.write(data);

                req.end();
            },
            inputs: [16, 160, 1600, 16000]
        },
        function() {
            t.end();
        }
    );
});

test('invalid json', function(t) {
    mod_vasync.forEachParallel(
        {
            func: function(arg, callback) {
                var req, opts;

                opts = mod_common.mpu_default_opts();
                req = mod_http.request(opts, function(res) {
                    t.equal(res.statusCode, 400);
                    mpu_correct_error_headers(t, res);
                    res.resume();
                    callback(null);
                });

                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(err);
                });
                req.write(arg);

                req.end();
            },
            inputs: [
                '{',
                '{ "hello"',
                '{ "foo": bar }',
                '{ hello: "foo" }',
                '{ "foo": "bar" "baz": false }'
            ]
        },
        function() {
            t.end();
        }
    );
});

test('bad payload, no members', function(t) {
    var req;
    req = mod_http.request(mod_common.mpu_default_opts(), function(res) {
        t.equal(res.statusCode, 400);
        mpu_correct_error_headers(t, res);
        res.resume();
        t.end();
    });

    req.on('error', function(err) {
        t.fail(sprintf('received error: %r', err));
        t.end();
    });

    req.write('{}');
    req.end();
});

/*
 * Verify that if we're missing each of the required fields, that it fails.
 */
test('bad payload, missing members', function(t) {
    var payload, obj, key;
    var tests = [];

    payload = {};
    payload['version'] = 1;
    payload['nbytes'] = 3;
    payload['account'] = 'kefka';
    payload['objectId'] = 'gestahl';
    payload['parts'] = ['maduin'];

    for (key in payload) {
        obj = mod_jsprim.deepCopy(payload);
        delete obj[key];
        tests.push(obj);
    }

    mod_vasync.forEachParallel(
        {
            func: function(arg, callback) {
                var req, opts;

                opts = mod_common.mpu_default_opts();
                req = mod_http.request(opts, function(res) {
                    t.equal(res.statusCode, 400);
                    mpu_correct_error_headers(t, res);
                    res.resume();
                    callback(null);
                });

                req.on('error', function(err) {
                    t.fail(sprintf('received error: %r', err));
                    callback(err);
                });
                req.write(JSON.stringify(arg));

                req.end();
            },
            inputs: tests
        },
        function() {
            t.end();
        }
    );
});

test('bad payload, invalid version (string)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['version'] = 'foobar';

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid version (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['version'] = -1;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid version (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['version'] = 5;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid version (array)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['version'] = [3];

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid version (obj)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['version'] = {foo: true};

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid nbytes (string)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['nbytes'] = 'foobar';

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid nbytes (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['nbytes'] = -1;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid nbytes (array)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['nbytes'] = [3];

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid nbytes (obj)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['nbytes'] = {foo: true};

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid account (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['account'] = 34;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid account (array)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['account'] = [3];

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid account (obj)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['account'] = {foo: true};

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid objectId (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['objectId'] = 34;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid objectId (array)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['objectId'] = [3];

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid objectId (obj)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['objectId'] = {foo: true};

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid parts (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['parts'] = 34;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid parts (string)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['parts'] = 'foobar';

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid parts (array)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['parts'] = [3];

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid parts (obj)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['parts'] = {foo: true};

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid md5 (num)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['md5'] = 34;

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid md5 (array)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['md5'] = [3];

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid md5 (obj)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['md5'] = {foo: true};

    mpu_bad_payload(payload, t);
});

test('bad payload, invalid md5 (wrong len)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['md5'] = 'foobar';

    mpu_bad_payload(payload, t);
});

test('bad payload, bad b64 (wrong len)', function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['md5'] = 'kQyLxzEQsM0bxdK8rnglEQ*=';

    mpu_bad_payload(payload, t);
});

test('bad pyaload, too many parts', function(t) {
    var payload, i;

    payload = mpu_basic_bad_payload();
    payload['parts'] = [];
    for (i = 0; i < 20000; i++) {
        payload['parts'].push(i.toString());
    }

    mpu_bad_payload(payload, t);
});

test("bad payload, invalid account ('.')", function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['account'] = 'foo.bar';

    mpu_bad_payload(payload, t);
});

test("bad payload, invalid account ('/')", function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['account'] = 'foo/bar';

    mpu_bad_payload(payload, t);
});

test("bad payload, invalid objectId ('.')", function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['objectId'] = 'foo.bar';

    mpu_bad_payload(payload, t);
});

test("bad payload, invalid objectId ('/')", function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['objectId'] = 'foo/bar';

    mpu_bad_payload(payload, t);
});

test("bad payload, invalid parts ('.')", function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['parts'] = ['foo.bar'];

    mpu_bad_payload(payload, t);
});

test("bad payload, invalid parts ('/')", function(t) {
    var payload;

    payload = mpu_basic_bad_payload();
    payload['parts'] = ['foo/bar'];

    mpu_bad_payload(payload, t);
});
