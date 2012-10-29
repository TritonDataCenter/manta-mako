#!/bin/bash

###############################################################################
# This cleans manta objects by first sucking down all files under:
#  /manta_gc/mako/$ZONENAME
# Which come in the following format:
#  mako + \t + serverUrl + \t + serverId + \t + zoneId + \t + ownerId +
#    \t + objectId
#
# Since manta objects are kept under /manta/ownerId/objectId, the ids are taken
# from the lines in the file and used to find and unlink the objects on the
# local filesystem.  When it is done it deletes the file in manta.
###############################################################################

export PATH=/opt/local/bin:$PATH



## Global vars

# Immutables

[ -z $SSH_KEY ] && SSH_KEY=/root/.ssh/id_rsa
[ -z $MANTA_KEY_ID ] && MANTA_KEY_ID=$(ssh-keygen -l -f $SSH_KEY.pub | awk '{print $2}')
[ -z $MANTA_URL ] && MANTA_URL=$(mdata-get manta_url)
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


function manta_get() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X GET \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        || fatal "unable to get $1"
}


function manta_delete() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X DELETE \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        || fatal "unable to delete $1"
}



## Main

: ${ZONENAME:?"Zonename must be set."}

log "starting gc"
COUNT=0
MPATH=/manta_gc/mako/$ZONENAME
for JSON in `manta_get $MPATH`
do
    #Fields 5 and 6 are the owner and object ids, respectively.
    FILE=$(echo $JSON | json -a name)
    MFILE=$MPATH/$FILE
    for OBJECT in `manta_get $MFILE | grep "^mako.*$ZONENAME" | cut -f 5,6 | tr '\t' '/' | xargs -i echo /manta/{}`;
    do
        log "Removing $OBJECT"
        rm -f $OBJECT
    done
    [[ $? -eq 0 ]] || fatal "error processing $MFILE."

    manta_delete $MFILE

    ((COUNT++))
    log "success processing $MFILE."
done

[[ $? -eq 0 ]] || fatal "Couldnt get $MPATH"

log "gc done, processed $COUNT files"
exit 0;
