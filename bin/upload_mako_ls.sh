#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

###############################################################################
# This takes a recursive directory listing of /manta/ and saves it to
# /var/tmp/mako_rollup
###############################################################################

export PATH=/opt/local/bin:$PATH

## Global vars

# Immutables

PID=$$
PID_FILE=/tmp/upload_mako_ls.pid
TMP_DIR=/var/tmp/mako_dir
START_TIME=`date -u +"%Y-%m-%dT%H:%M:%SZ"` # Time that this script started.

## Functions

function fatal {
    local LNOW=`date`
    echo "$LNOW: $(basename $0): fatal error: $*" >&2
    exit 1
}

function log {
    local LNOW=`date`
    echo "$LNOW: $(basename $0): info: $*" >&2
}

## Main

# Check the last pid to see if a previous cron is still running...
LAST_PID=$(cat $PID_FILE 2>/dev/null)

if [[ -n "$LAST_PID" ]]; then
    ps -p $LAST_PID >/dev/null
    if [[ $? -eq 0 ]]; then
        echo "$0 process still running.  Exiting..."
        exit 1
    fi
fi

echo -n $PID >$PID_FILE

log "starting mako rollup"

/opt/smartdc/mako/bin/mako_rollup > /var/tmp/mako_rollup.tmp
if [[ $? -ne 0 ]]; then
    fatal "Mako rollup failed!"
else
    mv /var/tmp/mako_rollup.tmp /var/tmp/mako_rollup
fi

log "Cleaning up..."
rm $PID_FILE

log "Done."

exit 0;
