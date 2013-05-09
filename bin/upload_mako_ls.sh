#!/bin/bash

###############################################################################
# This takes a recursive directory listing of /manta/ and uploads it to
# /poseidon/stor/mako/$(manta_storage_id)
###############################################################################

export PATH=/opt/local/bin:$PATH



## Global vars

# Immutables

[ -z $SSH_KEY ] && SSH_KEY=/root/.ssh/id_rsa
[ -z $MANTA_KEY_ID ] && MANTA_KEY_ID=$(ssh-keygen -l -f $SSH_KEY.pub | awk '{print $2}')
[ -z $MANTA_URL ] && MANTA_URL=$(cat /opt/smartdc/mako/etc/gc_config.json | json -ga manta_url)
[ -z $MANTA_USER ] && MANTA_USER=poseidon
[ -z $MANTA_STORAGE_ID ] && MANTA_STORAGE_ID=$(cat /opt/smartdc/mako/etc/gc_config.json | json -ga manta_storage_id)

AUTHZ_HEADER="keyId=\"/$MANTA_USER/keys/$MANTA_KEY_ID\",algorithm=\"rsa-sha256\""
DIR_TYPE='application/json; type=directory'
LOG_TYPE='application/x-bzip2'



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
        $MANTA_URL/$MANTA_USER/stor$1 2>&1
}


function manta_put() {
    sign || fatal "unable to sign"
    curl -vfsSk \
        -X PUT \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER,signature=\"$SIGNATURE\"" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        --data-binary @$2 \
        || fatal "unable to put $1"
}



## Main

: ${MANTA_STORAGE_ID:?"Manta Storage Id must be set."}

log "starting directory listing upload"

TMP_DIR=/tmp/mako_dir
LISTING_FILE=$TMP_DIR/$MANTA_STORAGE_ID
MANTA_DIR=/mako

mkdir -p $TMP_DIR

# %p is filename, %s is size in bytes, %T@ is last modified time, unix time
find /manta -type f -printf '%p\t%s\t%T@\n' >$LISTING_FILE

manta_put_directory $MANTA_DIR

manta_put $MANTA_DIR/$MANTA_STORAGE_ID $LISTING_FILE

rm -rf $TMP_DIR

log "Uploaded $LISTING_FILE to $MANTA_DIR/$MANTA_STORAGE_ID"

exit 0;
