#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
#

#
# This script reads the instructions files from the feeder(s) which have
# aggregated them from the garbage-collectors.
#

###############################################################################
# The instructions files from the feeders come in the following format:
#
#  mako + \t + mantaStorageId + \t + ownerId + \t + objectId
#
# Since manta objects are kept under /manta/ownerId/objectId, the ids are taken
# from the lines in the file and used to find and unlink the objects on the
# local filesystem.
###############################################################################

if [[ -n $TRACE ]]; then
    set -o xtrace
fi


export PATH=/opt/local/bin:$PATH

# Configuration (generally should not be changed)

BAD_INSTRUCTIONS_DIR=/var/spool/manta_gc/bad_instructions
INSTRUCTIONS_DIR=/var/spool/manta_gc/instructions
[[ -z $MANTA_STORAGE_ID ]] && MANTA_STORAGE_ID=$(cat /opt/smartdc/mako/etc/gc_config.json | json -ga manta_storage_id)
[[ -z $MANTA_URL ]] && MANTA_URL=$(cat /opt/smartdc/mako/etc/gc_config.json | json -ga manta_url)
METRICS_FILE=/var/spool/manta_gc/metrics/mako_gc

# Immutables

FEEDER_PATH=/var/spool/manta_gc/mako/$MANTA_STORAGE_ID
HOSTNAME=`hostname`
PID=$$
PID_FILE=/tmp/mako_mantaless_gc.pid
PREV_PID_FILE=/tmp/mako_gc.pid
SCRIPT=$(basename $0)

# Mutables

CREATED_PID_FILE=0
ERROR="true"
FILE_COUNT=0
LOADED_METRICS=0

METRIC_RSYNC_FILES=0
METRIC_PROCESSED_FILES=0
METRIC_INSTRUCTIONS_INVALID=0
METRIC_INSTRUCTIONS_MISDIRECTED=0
METRIC_INSTRUCTIONS_TOTAL=0
METRIC_LOGICAL_BYTES=0
METRIC_MISSING_FILES=0
METRIC_PHYSICAL_BYTES=0


## Functions

#
# For logging purposes, we keep track of the current date stamp in a global
# $LNOW variable.  To avoid calling date(1) whenever we wish to log, we only
# update the date stamp if the $SECONDS variable (which, in bash(1) is the
# integer number of seconds since the script was invoked) does not match our
# cached value.  This means that it's possible for our date stamp to be
# slightly out of date with respect to the system clock, but by less than one
# second -- which we consider to be acceptable considering we only have
# second resolution.
#
function updatelnow {
    if [[ $SECONDS != $LASTLNOW ]]; then
        LNOW=`date "+%Y-%m-%dT%H:%M:%S.000Z"`
        LASTLNOW=$SECONDS
    fi
}


function cleanup {
    #
    # Write a final log message.
    #
    audit

    #
    # Write out the updated metrics if we ever got as far as loading them.
    #
    if [[ $LOADED_METRICS -ne 0 ]]; then
        write_metrics
    fi

    #
    # If we created the PID_FILE we should clean it up. We *are* part of the
    # garbage collector solution!
    #
    if [[ $CREATED_PID_FILE -ne 0 ]]; then
        rm -f $PID_FILE
    fi
}
trap cleanup EXIT


function fatal {
    updatelnow
    echo "$LNOW: $SCRIPT ($PID): fatal error: $*" >&2
    exit 1
}


function log {
    updatelnow
    echo "$LNOW: $SCRIPT ($PID): info: $*" >&2
}


# Since we use bunyan, this mimics a json structure.
function audit {
    updatelnow

    echo "{\
\"audit\":true,\
\"name\":\"mako_gc\",\
\"level\":30,\
\"error\":$ERROR,\
\"msg\":\"audit\",\
\"v\":0,\
\"time\":\"$LNOW\",\
\"pid\":$PID,\
\"cronExec\":1,\
\"hostname\":\"$HOSTNAME\",\
\"fileCount\":\"$FILE_COUNT\",\
\"tombDirCleanupCount\":\"0\"\
}" >&2
}


function load_metrics {
    local rsync_files
    local processed_files
    local missing_files
    local instructions_total
    local instructions_invalid
    local instructions_misdirected
    local logical_bytes
    local physical_bytes

    #
    # It's important that the order here match that in write_metrics.
    #
    read \
        rsync_files \
        processed_files \
        missing_files \
        instructions_total \
        instructions_invalid \
        instructions_misdirected \
        logical_bytes \
        physical_bytes \
        <<<$(head -1 $METRICS_FILE || true)

    #
    # We ensure all the values are set and numbers. If they're negative
    # (because of a bug/rollover) they'll not match our regex here and we will
    # leave them set to 0 (initialized above) which works just fine for
    # Prometheus counters. Fwiw on the bash we'll be using the max value is
    # 9223372036854775807 before rollover.
    #
    [[ -n $rsync_files && "$rsync_files" =~ ^[0-9]+$ ]] \
        && METRIC_RSYNC_FILES=$rsync_files
    [[ -n $processed_files && "$processed_files" =~ ^[0-9]+$ ]] \
        && METRIC_PROCESSED_FILES=$processed_files
    [[ -n $missing_files && "$missing_files" =~ ^[0-9]+$ ]] \
        && METRIC_MISSING_FILES=$missing_files
    [[ -n $instructions_total && "$instructions_total" =~ ^[0-9]+$ ]] \
        && METRIC_INSTRUCTIONS_TOTAL=$instructions_total
    [[ -n $instructions_invalid && "$instructions_invalid" =~ ^[0-9]+$ ]] \
        && METRIC_INSTRUCTIONS_INVALID=$instructions_invalid
    [[ -n $instructions_misdirected && "$instructions_misdirected" =~ ^[0-9]+$ ]] \
        && METRIC_INSTRUCTIONS_MISDIRECTED=$instructions_misdirected
    [[ -n $logical_bytes && "$logical_bytes" =~ ^[0-9]+$ ]] \
        && METRIC_LOGICAL_BYTES=$logical_bytes
    [[ -n $physical_bytes && "$physical_bytes" =~ ^[0-9]+$ ]] \
        && METRIC_PHYSICAL_BYTES=$physical_bytes

    LOADED_METRICS=1
}

function write_metrics {
    local output=""

    #
    # Write out the metrics values. It's important that these remain in the same
    # order as load_metrics.
    #
    output="$METRIC_RSYNC_FILES"
    output="$output $METRIC_PROCESSED_FILES"
    output="$output $METRIC_MISSING_FILES"
    output="$output $METRIC_INSTRUCTIONS_TOTAL"
    output="$output $METRIC_INSTRUCTIONS_INVALID"
    output="$output $METRIC_INSTRUCTIONS_MISDIRECTED"
    output="$output $METRIC_LOGICAL_BYTES"
    output="$output $METRIC_PHYSICAL_BYTES"

    mkdir -p $(dirname $METRICS_FILE)

    echo "$output" > $METRICS_FILE
}

#
# To ensure that we are processing the latest files generated by the
# garbage-collectors, we need to rsync with the feeder for our region. This
# function determines which region we are in by looking at the MANTA_URL that
# is set and maps it to a pre-defined feeder IP. Once determined this function
# will consume any files on the feeder into:
#
#   /var/spool/manta_gc/mako/<storageId>
#
# locally.
#
function rsync_from_feeder() {
    local created_reg
    local feeder_ip=$(mdata-get feeder-ip || true)
    local output
    local region

    if [[ -z $feeder_ip ]]; then
        declare -A FEEDER_MAP
        FEEDER_MAP["us-east"]="10.64.7.121"
        FEEDER_MAP["eu-central"]="10.72.4.77"
        FEEDER_MAP["ap-southeast"]="10.80.2.152"
        FEEDER_MAP["ap-northeast"]="10.92.68.54"
        region=$(echo $MANTA_URL | awk -F'.' '{ print $2 }')
        if [[ -z $region ]]; then
            fatal "Couldn't find Manta region"
        fi

        feeder_ip=${FEEDER_MAP["$region"]}
    fi

    if [[ -z $feeder_ip ]]; then
        fatal "Couldn't find Manta feeder"
    fi

    #
    # rsync the files from this collector to the mako.tmp directory.
    #
    output=$(rsync \
        --stats \
        --remove-source-files \
        -a \
        "rsync://${feeder_ip}/manta_gc/mako/${MANTA_STORAGE_ID}/" \
        ${INSTRUCTIONS_DIR}/ \
        2>&1)

    #
    # If the rsync failed, we still want to print the output to the log. Then
    # the rsync_count will be 0. We'll also likely not have any *new* files as a
    # result. But, we might have older files sitting in the queue and we don't
    # want a broken rsync to prevent us from processing them. So in this case
    # we continue on.
    #

    echo "== RSYNC OUTPUT/ =="
    echo "$output"
    echo "== /RSYNC OUTPUT =="

    #
    # Parse the output for the rsync stats line that looks like:
    #
    #   Number of created files: 56 (reg: 54, dir: 2)
    #
    # from that we look at the "reg: " number which is the number of regular
    # files created and we use that to update the counter for the total number
    # of files we've rsync'd which can be used my cmon-agent metrics plugins.
    #
    rsync_count=$(grep "^Number of created files.*reg: " <<<"$output" \
        | sed -e 's/Number of created files:.*reg: \([0-9\,]*\).*/\1/' \
        | tr -d ',')
    [[ -n $rsync_count ]] || rsync_count=0

    log "rsync'd $rsync_count files from feeder($feeder_ip) using MANTA_STORAGE_ID: $MANTA_STORAGE_ID"

    ((METRIC_RSYNC_FILES=METRIC_RSYNC_FILES+rsync_count))

    return 0
}

#
# Process a single "instructions" file.
#
function process_file() {
    local LFILE="$1"
    local results=""

    log "Processing file $LFILE"

    # Call the rust based gc app to do the hot loop
    results=$(/opt/smartdc/mako/bin/process_instructions "$LFILE" "$MANTA_STORAGE_ID")
    if [[ $? -ne 0 ]]; then
        log "Instruction processor failed for $LFILE. Moving on to the next file."
        mv "$LFILE" "$BAD_INSTRUCTIONS_DIR/."
    else
        rm -f $LFILE
        [[ $? -eq 0 ]] || fatal "Unable to rm $LFILE. Something is wrong."
    fi

    echo "== processor output/ =="
    echo "$results"
    echo "== /processor output =="

    # Order matters here. Must match the gc.rs program.
    read \
        instruction_count \
        invalid_instructions \
        misdirected_instructions \
        missing_objects \
        logical_bytes_deleted \
        physical_bytes_deleted \
        <<<"$results"

    #
    # Increment the global counters.
    #
    [[ -n $instruction_count && $instruction_count =~ ^[0-9]+$ ]] \
        && ((METRIC_INSTRUCTIONS_TOTAL=METRIC_INSTRUCTIONS_TOTAL+instruction_count))
    [[ -n $invalid_instructions && $invalid_instructions =~ ^[0-9]+$ ]] \
        && ((METRIC_INSTRUCTIONS_INVALID=METRIC_INSTRUCTIONS_INVALID+invalid_instructions))
    [[ -n $misdirected_instructions && $misdirected_instructions =~ ^[0-9]+$ ]] \
        && ((METRIC_INSTRUCTIONS_MISDIRECTED=METRIC_INSTRUCTIONS_MISDIRECTED+misdirected_instructions))
    [[ -n $missing_objects && $missing_objects =~ ^[0-9]+$ ]] \
        && ((METRIC_MISSING_FILES=METRIC_MISSING_FILES+missing_objects))
    [[ -n $logical_bytes_deleted && $logical_bytes_deleted =~ ^[0-9]+$ ]] \
        && ((METRIC_LOGICAL_BYTES=METRIC_LOGICAL_BYTES+logical_bytes_deleted))
    [[ -n $physical_bytes_deleted && $physical_bytes_deleted =~ ^[0-9]+$ ]] \
        && ((METRIC_PHYSICAL_BYTES=METRIC_PHYSICAL_BYTES+physical_bytes_deleted))

    #
    # We want to count the total files both from this run ($FILE_COUNT) and
    # since last reset ($METRIC_PROCESSED_FILES) so we increment them both here
    # every time we have processed a file.
    #
    ((METRIC_PROCESSED_FILES++))
    ((FILE_COUNT++))

    log "success processing $LFILE."

    return 0
}

## Main

: ${MANTA_STORAGE_ID:?"Manta storage id must be set."}

mkdir -p $INSTRUCTIONS_DIR
mkdir -p $BAD_INSTRUCTIONS_DIR

#
# Check the old name for the pid file. This was used after CM-2915 but that
# conflicts with the existing mako_gc.sh such that the two scripts cannot
# both run at the same time. In order to facilitate upgrading from that
# version to this version, we also check for that pid file. If it exists, we'll
# exit only if that's also *us*.
#
# When that running process exits, the next time we'll create *our own* pid
# file with the new name and from then on, it'll never be us using that pid
# file. So this code can be removed on the next update.
#
LAST_PID=$(cat $PREV_PID_FILE 2>/dev/null || true)
if [[ -n "$LAST_PID" ]]; then
    if kill -0 $LAST_PID; then
        if [[ "$(pargs -l $LAST_PID)" =~ "mako_mantaless_gc.sh" ]]; then
            echo "$0 process still running.  Exiting..."
            exit 1
        fi
    fi
fi

# Check the last pid to see if a previous cron is still running...
LAST_PID=$(cat $PID_FILE 2>/dev/null || true)
if [[ -n "$LAST_PID" ]]; then
    if kill -0 $LAST_PID; then
        echo "$0 process still running.  Exiting..."
        exit 1
    fi
fi

CREATED_PID_FILE=1
echo -n $PID >$PID_FILE

if [[ ! -x /opt/smartdc/mako/bin/process_instructions ]]; then
    fatal "Missing 'process_instructions' tool, will not be able to collect any garbage"
fi

# Load existing values of metrics (now that we're the only one running)
load_metrics

# Update our files to process
log "rsync from feeder"
rsync_from_feeder

# Ok, we're good to start gc
log "starting gc"

shopt -s nullglob
for file in "$INSTRUCTIONS_DIR"/*
do
    process_file "$file"
done

# If we made it here, we're awesome.
ERROR="false"

exit 0
