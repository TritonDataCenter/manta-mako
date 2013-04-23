#!/bin/bash

###############################################################################
# This takes a recursive directory listing of /manta/ and uploads it to
# /poseidon/stor/mako/$(zonename)
###############################################################################

export PATH=/opt/local/bin:$PATH



## Global vars

# Immutables

[ -z $SSH_KEY ] && SSH_KEY=/root/.ssh/id_rsa
[ -z $MANTA_KEY_ID ] && MANTA_KEY_ID=$(ssh-keygen -l -f $SSH_KEY.pub | awk '{print $2}')
[ -z $MANTA_URL ] && MANTA_URL=$(curl -s $(mdata-get SAPI_URL)/configs/$(zonename) | \
                                 json -ga metadata.MANTA_URL)
[ -z $MANTA_USER ] && MANTA_USER=poseidon
[ -z $ZONENAME ] && ZONENAME=$(/usr/bin/zonename)

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
    SIGNATURE=$(echo $NOW | tr -d '\n' | \
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
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 2>&1
}


function manta_put() {
    sign || fatal "unable to sign"
    curl -vfsSk \
        -X PUT \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        --data-binary @$2 \
        || fatal "unable to put $1"
}



## Main

: ${ZONENAME:?"Zonename must be set."}

log "starting directory listing upload"

TMP_DIR=/tmp/mako_dir
LISTING_FILE=$TMP_DIR/$ZONENAME
MANTA_DIR=/mako

mkdir -p $TMP_DIR

find /manta -type f >$LISTING_FILE

manta_put_directory $MANTA_DIR

manta_put $MANTA_DIR/$ZONENAME $LISTING_FILE

rm -rf $TMP_DIR

log "Uploaded $LISTING_FILE to $MANTA_DIR/$ZONENAME"

exit 0;
