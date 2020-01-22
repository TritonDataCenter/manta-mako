/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * This file contains tests for the `garbage-deleter` which require actual
 * filesystem calls. Tests which can be run without filesystem calls belong in
 * garbage-deleter.XXX.test.js.
 *
 */
var child_process = require('child_process');
var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var test = require('@smaller/tap').test;
var uuidv4 = require('uuid/v4');

var GarbageDeleter = require('../../lib/garbage-deleter.js');

var BIG_FILE_SIZE = '10M';
var TEST_DIR = path.join('/tmp', _randomString() + '.garbage-deleter-test');
var TEST_DIR_BAD_INSTR = path.join(TEST_DIR, 'bad_instructions');
var TEST_DIR_BAD_INSTR_TMP = path.join(TEST_DIR, 'bad_instructions.tmp');
var TEST_DIR_INSTR = path.join(TEST_DIR, 'instructions');
var TEST_DIR_INSTR_TMP = path.join(TEST_DIR, 'instructions.tmp');
var TEST_DIR_MANTA = path.join(TEST_DIR, 'manta');

var deleteEmitter = new EventEmitter();
var deleter;
var logs = {
    debug: [],
    error: [],
    info: [],
    trace: [],
    warn: []
};
var logger = {
    child: function _child() {
        return logger;
    },
    debug: function _debug() {
        logs.debug.push(Array.from(arguments));
    },
    error: function _error() {
        logs.error.push(Array.from(arguments));
    },
    info: function _info() {
        logs.info.push(Array.from(arguments));
    },
    trace: function _trace() {
        logs.trace.push(Array.from(arguments));
    },
    warn: function _warn() {
        logs.warn.push(Array.from(arguments));
    }
};
var test_dirs_created = false;


function _createTestDirs(t) {
    var dir;
    var dirs = [
        TEST_DIR,
        TEST_DIR_BAD_INSTR,
        TEST_DIR_BAD_INSTR_TMP,
        TEST_DIR_INSTR,
        TEST_DIR_INSTR_TMP,
        TEST_DIR_MANTA
    ];
    var i;

    for (i = 0; i < dirs.length; i++) {
        dir = dirs[i];
        fs.mkdirSync(dir);
        t.ok(true, 'create ' + dir);
    }

    test_dirs_created = true;
}

function _deleteTestDirs(t) {
    child_process.execFileSync('/usr/bin/rm', ['-fr', TEST_DIR], {});
    t.ok(true, 'delete ' + TEST_DIR);
}

function _instrFilename() {
    var date = new Date().toISOString().replace(/[-\:]/g, '').replace(/\..*$/, 'Z');

    // This matches what we're using in the consumers
    return ([
        date,
        uuidv4(),
        'X',
        uuidv4(),
        'mako-1.stor.test.joyent.us'
    ].join('-') + '.instruction');
}

function _testFile(t, options, callback) {
    assert.object(t, 't');
    assert.object(options, 'options');
    assert.string(options.filename, 'options.filename');
    assert.string(options.desc, 'options.desc');
    assert.string(options.contents, 'options.contents');
    assert.func(callback, 'callback');

    var filename = options.filename;
    var filenameBadPath = path.join(TEST_DIR_BAD_INSTR, filename);
    var filenameTmpPath = path.join(TEST_DIR_INSTR_TMP, filename);
    var filenamePath = path.join(TEST_DIR_INSTR, filename);
    var returnErr;

    deleteEmitter.once('processed', function _sawProcessed(obj) {
        t.equal(obj.filename, filename,
            'saw expected file processed by GarbageDeleter');

        callback(returnErr, {
            filename: filename,
            filenameBadPath: filenameBadPath,
            filenamePath: filenamePath,
            filenameTmpPath: filenameTmpPath,
        }, obj);
    });

    fs.writeFile(filenameTmpPath, options.contents, function _onWrite(err) {
        t.error(err, options.desc);

        if (err) {
            returnErr = err;
            return;
        }

        // Move into instr dir atomically. Like nginx does.
        fs.rename(filenameTmpPath, filenamePath, function _onRename(e) {
            t.error(e, 'rename temp file');
            if (e) {
                returnErr = e;
                return;
            }

            // If we succeeded in creating the instruction, it will now be
            // processed and we'll eventually get to the 'processed' event
            // handler above which will call the callback and the caller can
            // complete this test.
        });
    });
}

function _randomString() {
    return Math.random().toString(36).slice(2);
}

function _processFileHook(obj) {
    deleteEmitter.emit('processed', obj);
}


// setup

test('create testdirs', function _testCreateTestdirs(t) {
    t.doesNotThrow(function _callCreator() {_createTestDirs(t)},
        'create test directories');
    t.end();
});

test('create GarbageDeleter', function _testCreateDeleter(t) {
    deleter = new GarbageDeleter({
        badInstructionDir: TEST_DIR_BAD_INSTR,
        config: {},
        instructionDir: TEST_DIR_INSTR,
        log: logger,
        mantaRoot: TEST_DIR_MANTA,
        _processFileHook: _processFileHook
        // metricsManager: ctx.metricsManager
    });

    t.ok(deleter, 'create GarbageDeleter');

    deleter.start(function _started() {
        t.ok(true, 'start GarbageDeleter');
        t.end();
    });
});


// test meat


// Ensure that when the file is missing .instruction suffix, we reject it.
test('test instruction file missing .instruction suffix',
function _testNonInstructionFile(t) {

    _testFile(t, {
        contents: 'nothing really matters\n',
        desc: 'create file missing .instruction suffix',
        filename: _instrFilename() + '.trash'
    }, function _onProcessed(err, info, obj) {
        if (!err) {
            if (obj.filename === info.filename) {
                t.equal('MissingInstructionSuffixError', obj.err.name,
                    'should fail due to file missing .instruction suffix');

                t.ok(fs.existsSync(info.filenameBadPath),
                    'file should have been moved to bad_instructions dir');
            }
        }
        t.end();
    });

});

// Ensure that when the file is empty, we reject it.
test('test empty instruction file', function _testEmptyInstructionFile(t) {

    _testFile(t, {
        contents: '',
        desc: 'create empty file',
        filename: _instrFilename()
    }, function _onProcessed(err, info, obj) {
        if (!err && obj.filename === info.filename) {
            t.equal('EmptyFileError', obj.err.name,
                'should fail due to file being empty');

            t.ok(fs.existsSync(info.filenameBadPath),
                'file should have been moved to bad_instructions dir');
        }
        t.end();
    });

});

// Ensure that when the first instruction is too long, we reject it.
test('test long first instruction', function _testLongFirstInstruction(t) {
    // This doesn't need to have correct data in it, we just want it to be too
    // long so that the line is rejected for parsing.
    var longLine = '';

    while (longLine.length <= deleter.maxLineLength) {
        longLine += _randomString();
    }

    _testFile(t, {
        contents: longLine + '\n',
        desc: 'create file with long line',
        filename: _instrFilename()
    }, function _onProcessed(err, info, obj) {
        if (!err) {
            if (obj.filename === info.filename) {
                t.equal('LineTooLongError', obj.err.name,
                    'should fail due to line being too long');

                t.ok(fs.existsSync(info.filenameBadPath),
                    'file should have been moved to bad_instructions dir');
            }
        }
        t.end();
    });

});

// Ensure instructions rejected if there are too many.
test('test too many instructions', function _testTooManyInstructions(t) {
    // This doesn't need to have correct data in it, we just want there to be
    // too many instructions so the file is rejected.
    var lines = [];

    while (lines.length <= deleter.maxLines) {
        lines.push(uuidv4());
    }

    _testFile(t, {
        contents: lines.join('\n') + '\n',
        desc: 'create file with too many lines',
        filename: _instrFilename()
    }, function _onProcessed(err, info, obj) {
        if (!err) {
            if (obj.filename === info.filename) {
                t.equal('TooManyLinesError', obj.err.name,
                    'should fail from too many lines');

                t.ok(fs.existsSync(info.filenameBadPath),
                    'file should have been moved to bad_instructions dir');
            }
        }
        t.end();
    });

});

// Ensure files are actually deleted
test('test deletes actually work', function _testDeletesWork(t) {
    var idx;
    var lines = [];
    var mantaDir;
    var mantaObjects = [];
    var mantaOwner = uuidv4();
    var storageId = uuidv4();

    mantaDir = path.join(TEST_DIR_MANTA, mantaOwner);

    t.doesNotThrow(function () {fs.mkdirSync(mantaDir);},
        'create test /manta/' + mantaOwner + ' dir');

    for (idx = 0; idx < 10; idx++) {
        mantaObjects.push(uuidv4());
        t.doesNotThrow( function () {
            fs.writeFileSync(path.join(mantaDir, mantaObjects[idx]));
        }, 'write manta file ' + mantaOwner + '/' + mantaObjects[idx]);

        //  fields[0] is our storageId
        //  fields[1] is a uuid (creator UUID)
        //  fields[2] is a uuid (object UUID)
        //  fields[4] is a number (size)

        lines.push([
            storageId, mantaOwner, mantaObjects[idx], 'blah', Math.floor(Math.random() * 1000)
        ].join('\t'));

    }

    _testFile(t, {
        contents: lines.join('\n') + '\n',
        desc: 'create file actual deletes',
        filename: _instrFilename()
    }, function _onProcessed(err, info, obj) {
        t.error(err, 'should be no error deleting files');

        /*
        console.error('error: ' + JSON.stringify(err));
        console.error('info: ' + JSON.stringify(info));
        console.error('obj: ' + JSON.stringify(obj));
        */

        for (idx = 0; idx < 10; idx++) {
            t.notOk(fs.existsSync(path.join(mantaDir, mantaObjects[idx])),
                mantaObjects[idx] + ' should have been deleted');
        }

        // TODO: file should have been deleted

        t.end();
    });

});

// teardown

test('stop GarbageDeleter', function _testStopDeleter(t) {
    deleter.stop(function _onStop(err) {
        t.error(err, 'stop GarbageDeleter');
        t.end();
    });
});

test('check metrics', function _testMetrics(t) {
    // This just checks that the metrics were set to some approximately
    // reasonable values.

    var metrics = deleter.metrics;

    function tGreater(metric, compare) {
        if (typeof(compare) === 'number') {
            t.ok(metrics[metric] > compare, metric + '(' + metrics[metric] +
                ') > ' + compare);
        } else if (typeof(compare) === 'string') {
            t.ok(metrics[metric] > metrics[compare], metric +
                '(' + metrics[metric] + ') > ' + compare + '(' +
                metrics[compare] + ')');
        } else {
            t.ok(false, 'bad tGreater type: ' + typeof(compare));
        }
    }

    tGreater('instructionFilesProcessed', 0);
    tGreater('badInstructionFiles', 0);
    tGreater('instructionFilesProcessed', 'badInstructionFiles');
    tGreater('instructionLinesProcessed', 0);
    tGreater('deleteCountTotal', 0);
    tGreater('deleteTimeTotalSeconds', 0);
    tGreater('instructionFilesDeleted', 0);
    tGreater('deleteTimeMinSeconds', 0);
    tGreater('deleteTimeMaxSeconds', 0);
    tGreater('deleteTimeMaxSeconds', 'deleteTimeMinSeconds');
    tGreater('deleteTimeTotalSeconds', 'deleteTimeMaxSeconds');

    t.end();
});

test('delete testdirs', function _testDeleteTestdirs(t) {
    t.doesNotThrow(function _callDeleter() {_deleteTestDirs(t)},
        'delete test directories');
    t.end();
});

test('dump logs', function _testDumpLogs(t) {
    var enabled = Boolean(process.env.DUMP_LOGS);

    t.ok(true, 'log dump (env DUMP_LOGS is' + (!enabled ? ' not' : '') + ' set)' , {skip: !enabled});

    if (process.env.DUMP_LOGS) {
        console.log(JSON.stringify(logs, null, 2));
    }

    t.end();
});
