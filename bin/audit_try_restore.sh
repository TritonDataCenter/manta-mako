#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# This script will sort through audit output and attempt to restore objects from
# tombstone back to the proper place.  It's a bit brute-force so it could take
# a while.
#
. ~/.bashrc

if [[ -z "$1" ]]; then
    echo "usage: $0 <job_uuid>"
    exit 1
fi

JOB_UUID=$1
STORAGE_ID=$(json -f /opt/smartdc/mako/etc/gc_config.json | \
    json manta_storage_id)
mget -q $(mjob outputs $JOB_UUID) | while read l; do
    sid=$(echo  "$l" | cut -f 2)

    if [[ $sid != $STORAGE_ID ]]; then
        continue
    fi

    obj_uuid=$(echo "$l" | cut -f 1)
    owner_uuid=$(echo "$l" | cut -f 4 | cut -d '/' -f 2)
    filename=/manta/$owner_uuid/$obj_uuid

    if [[ -e $filename ]]; then
        echo "SUCCESS: ALREADY RESTORED: $filename from $tombfile ($l)"
        continue;
    fi

    tombfile=$(find /manta/tombstone -name $obj_uuid)
    if [[ -z $tombfile ]]; then
        echo "ERROR: NO TOMBFILE: $l"
        continue;
    fi

    mv $tombfile $filename
    echo "SUCCESS: RESTORED: $filename from $tombfile ($l)"
done
