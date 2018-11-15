#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

###############################################################################
# This takes a recursive directory listing of /manta/ and uploads it to
# /$MANTA_USER/stor/mako/$(manta_storage_id)
###############################################################################

export PATH=/opt/local/bin:$PATH



## Global vars

# Immutables

[ -z $SSH_KEY ] && SSH_KEY=/root/.ssh/id_rsa
[ -z $MANTA_KEY_ID ] && MANTA_KEY_ID=$(ssh-keygen -l -f $SSH_KEY.pub | gawk '{print $2}')
[ -z $MANTA_URL ] && MANTA_URL=$(cat /opt/smartdc/mako/etc/gc_config.json | json -ga manta_url)
[ -z $MANTA_USER ] && MANTA_USER=$(json -f /opt/smartdc/common/etc/config.json manta.user)
[ -z $MANTA_STORAGE_ID ] && MANTA_STORAGE_ID=$(cat /opt/smartdc/mako/etc/gc_config.json | json -ga manta_storage_id)

MAKO_PROCESS_MANIFEST=$(json -f /opt/smartdc/mako/etc/upload_config.json process_manifest)
AUTHZ_HEADER="keyId=\"/$MANTA_USER/keys/$MANTA_KEY_ID\",algorithm=\"rsa-sha256\""
DIR_TYPE='application/json; type=directory'
LOG_TYPE='application/x-bzip2'
PID=$$
PID_FILE=/tmp/upload_mako_ls.pid
TMP_DIR=/var/tmp/mako_dir
LISTING_FILE=$TMP_DIR/$MANTA_STORAGE_ID
LISTING_FILE_PARTIAL=${LISTING_FILE}.${PID}
MANTA_DIR=mako
SUMMARY_FILE="$TMP_DIR/${MANTA_STORAGE_ID}.summary"
SUMMARY_DIR="$MANTA_DIR/summary"
MAKO_DIR=/opt/smartdc/mako
TARGET_DIR=/manta
START_TIME=`date -u +"%Y-%m-%dT%H:%M:%SZ"` # Time that this script started.

# Mutables

NOW=""
SIGNATURE=""

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

function sign() {
    NOW=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    SIGNATURE=$(echo "date: $NOW" | tr -d '\n' | \
        openssl dgst -sha256 -sign $SSH_KEY | \
        openssl enc -e -a | tr -d '\n') \
        || fatal "unable to sign data"
}

function manta_put_directory() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X PUT \
        -H "content-type: application/json; type=directory" \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER,signature=\"$SIGNATURE\"" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor/${1} 2>&1
}

function manta_put() {
    sign || fatal "unable to sign"

    datacenter=$(mdata-get sdc:datacenter_name)

    if [[ -z "$datacenter" ]]; then
        fatal "unable to determine datacenter"
    fi

    curl -vfsSk \
        -X PUT \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER,signature=\"$SIGNATURE\"" \
        -H "Connection: close" \
        -H "m-datacenter: $datacenter" \
        -H "m-mako-dump-time: $START_TIME" \
        $MANTA_URL/$MANTA_USER/stor/${1} \
        -T $2 \
        || fatal "unable to put $1"
}

#
# This function performs the heavy lifting when processing a mako manifest.  It
# builds out several associative arrays, each indexed by account id:
#
# bytes[acct] contains a running sum of the number of bytes that account `acct'
# currently consumed.  This value is obtained from the %s parameter in the call
# to gfind.
#
# objects[acct] contains a running count of the number of files that belong to
# account `acct'.
#
# kilobytes[acct] contains a sum of one- kilobyte blocks that account `acct'
# consumes.  This value is the actual amount of data on disk consumed by the
# account.
#
# At the completion of the call to gawk, the contents of each array are printed
# to give per-account information along with a global summary.
#
function process_manifest() {
    file="$1"

    if [ ! -f $file ]; then
        fatal "File $file does not exist."
    fi

    cat $file | gawk -M -v PREC="quad" '{
        split($1, x, "/")
        acct=x[3]
        bytes[acct] += $2
        objects[acct]++
        kilobytes[acct] += $4
        total_bytes += $2
        total_objects++
        total_kilobytes += $4

        #
        # If the Manta directory happens to be "tombstone" then x[4]
        # contains the name of the subdirectory which will always be
        # a date.  We want to organize the objects in this part of the
        # tree by their subdirectory name (i.e. its date of creation)
        # so that when analyzing a summary, a determination can be made
        # not only about how much storage we stand to reclaim in overall
        # but also _when_ we stand to reclaim each fraction of the
        # tombstone directory tree.
        #
        if (x[3] == "tombstone") {
            date=x[4]
            tombstone_bytes[date] += $2
            tombstone_kilobytes[date] += $4
            tombstone_objects[date]++
        }
    } END {
        printf("%s\t%s\t%s\t%s\t%s\n", "account", "bytes",
            "objects", "average size kb", "kilobytes");

        for (date in tombstone_bytes) {
            printf("tombstone_%s\t%f\t%f\t%f\t%f\n", date,
                tombstone_bytes[date], tombstone_objects[date],
                tombstone_kilobytes[date] / tombstone_objects[date],
                tombstone_kilobytes[date]);
        }

        for (acct in bytes) {
            printf("%s\t%f\t%f\t%f\t%f\n", acct, bytes[acct], objects[acct],
                kilobytes[acct] / objects[acct], kilobytes[acct]);
        }

        printf("%s\t%f\t%f\t%f\t%f\n", "totals", total_bytes, total_objects,
            total_kilobytes / total_objects, total_kilobytes);
    }' > "$SUMMARY_FILE"

    if [[ $? -ne 0 ]]; then
        rm "$SUMMARY_FILE"
        fatal "Unable to completely process mako manifest file $file."
    fi
}

function generate_manifest() {
    file=$1
    #
    # %p is the filename, %s is the logical size in bytes, %T@ is the
    # timestamp of the last modification and %k is the physical size (i.e.
    # size on disk) in kilobytes.  It is worth mentioning that in later
    # versions of GNU find (> 4.2.33), the timestamp includes both, the
    # number of seconds and the fractional part.  In order to maintain the
    # same format as earlier versions of the mako manifest, we perform some
    # onerous sequence of operations using gawk (below) to first separate
    # each parameter in the line with the assumption that each argument is
    # delimited by a tab.  We know that the third field (i.e. $3) will
    # contain the timestamp.  We perform a split on $3, further dividing
    # the field in to two smaller pieces, each delimited by a '.'.  This
    # is stored in array `y' where y[1] is the whole part of the timestamp
    # and y[2] is the fractional part.  No one is denying that this is not
    # elegant, but the change in the way that GNU find prints timestamps
    # permits few (if any) alternatives.
    #
    find "$TARGET_DIR" -type f -printf '%p\t%s\t%T@\t%k\n' |\
        gawk -M -v PREC="quad" -v FS="\t" -v OFS="\t" '{
        split($3, y, ".");
        print $1,$2,y[1],$4
    }'> "$file"

    if [[ $? -ne 0 ]]; then
        fatal "Error: find failed to obtain a complete listing"
    fi
}

## Main

: ${MANTA_STORAGE_ID:?"Manta Storage Id must be set."}

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

log "starting directory listing upload"

mkdir -p $TMP_DIR

generate_manifest "$LISTING_FILE_PARTIAL"

# Rename the file to reflect that find completed successfully
mv "$LISTING_FILE_PARTIAL" "$LISTING_FILE"

log "Going to upload $LISTING_FILE to $MANTA_DIR/$MANTA_STORAGE_ID"
manta_put_directory "$MANTA_DIR"
manta_put "$MANTA_DIR/$MANTA_STORAGE_ID" "$LISTING_FILE"

if [[ -z $MAKO_PROCESS_MANIFEST ]]; then
    fatal "Error: MAKO_PROCESS_MANIFEST not set.  Please check /opt/smartdc/mako/etc/upload_config.json"
fi

if [[ $MAKO_PROCESS_MANIFEST == true ]]; then
    log "Going to upload $SUMMARY_FILE to $SUMMARY_DIR/$MANTA_STORAGE_ID"
    process_manifest "$LISTING_FILE"
    manta_put_directory "$SUMMARY_DIR"
    manta_put "$SUMMARY_DIR/$MANTA_STORAGE_ID" "$SUMMARY_FILE"
fi

log "Cleaning up..."
rm -rf $TMP_DIR
rm $PID_FILE

log "Done."

exit 0;
