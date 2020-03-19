/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var NS_PER_SEC = 1e9;

//
// Return a Number of seconds elapsed between *now* and `beginning`. The
// `beginning` parameter must be a previous process.hrtime() result.
//
function elapsedSince(beginning) {
    var elapsed;
    var timeDelta;

    timeDelta = process.hrtime(beginning);
    elapsed = timeDelta[0] + timeDelta[1] / NS_PER_SEC;

    return elapsed;
}

module.exports = {
    elapsedSince: elapsedSince
};
