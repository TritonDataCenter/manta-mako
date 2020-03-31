/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Functionality common to all tests.
 */

var mod_assert = require('assert-plus');
var mod_extsprintf = require('extsprintf');
var sprintf = mod_extsprintf.sprintf;
var mod_stream = require('stream');
var mod_util = require('util');
var mod_crypto = require('crypto');

var MPU_HOST = 'localhost';
var MPU_PORT = 80;
var MPU_URL = '/mpu/v1/commit';

/*
 * Construct the basic mpu request options that are required for MPU.
 */
function mpu_default_opts() {
    var options = {};
    options['host'] = MPU_HOST;
    options['port'] = MPU_PORT;
    options['path'] = MPU_URL;
    options['method'] = 'POST';
    return options;
}

function mako_default_opts() {
    var options = {};
    options['host'] = MPU_HOST;
    options['port'] = MPU_PORT;
    return options;
}

/*
 * Set up the common environment variables, etc.
 */
function mpu_setup() {
    var port;

    if (process.env['MAKO_HOST']) {
        MPU_HOST = process.env['MAKO_HOST'];
    }

    if (process.env['MAKO_PORT']) {
        port = parseInt(process.env['MAKO_PORT'], 10);
        if (isNaN(port)) {
            process.stderr.write(
                sprintf(
                    'failed to parse port: ' + '%d: using default: %d\n',
                    process.env['MAKO_PORT'],
                    MPU_PORT
                )
            );
        } else {
            MPU_PORT = port;
        }
    }

    if (process.env['MPU_URL']) {
        MPU_URL = process.env['MPU_URL'];
    }
}

/*
 * Generates a stream of random data and updates an md5 instance with its data.
 */
function MPUSource(opts) {
    mod_assert.number(opts.length, 'amount of data is required');
    mod_assert.object(opts.md5, 'a crypto md5 object is required');

    this.mpus_remaining = opts.length;
    this.mpus_chunksize = 4 * 1024 * 1024;
    this.mpus_md5 = opts.md5;
    this.mpus_finished = false;

    mod_stream.Readable.call(this);
}

mod_util.inherits(MPUSource, mod_stream.Readable);

MPUSource.prototype._read = function() {
    var toWrite, buf;

    toWrite = Math.min(this.mpus_remaining, this.mpus_chunksize);
    if (toWrite === 0) {
        if (!this.mpus_finished) {
            this.mpus_finished = true;
            this.push(null);
        }
        return;
    }

    this.mpus_remaining -= toWrite;
    buf = mod_crypto.randomBytes(toWrite);
    this.mpus_md5.update(buf);
    this.push(buf);
};

exports.MPUSource = MPUSource;
exports.mpu_setup = mpu_setup;
exports.mpu_default_opts = mpu_default_opts;
exports.mako_default_opts = mako_default_opts;
