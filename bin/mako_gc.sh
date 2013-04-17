#!/bin/bash

###############################################################################
# This cleans manta objects by first sucking down all files under:
#  /manta_gc/mako/$MANTA_STORAGE_ID
# Which come in the following format:
#  mako + \t + mantaStorageId + \t + ownerId + \t + objectId
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
[ -z $MANTA_STORAGE_ID ] && MANTA_STORAGE_ID=$(mdata-get manta_storage_id)

AUTHZ_HEADER="keyId=\"/$MANTA_USER/keys/$MANTA_KEY_ID\",algorithm=\"rsa-sha256\""
DIR_TYPE='application/json; type=directory'
HOSTNAME=`hostname`
LOG_TYPE='application/x-bzip2'
MPATH=/manta_gc/mako/$MANTA_STORAGE_ID
PID=$$
TMP_DIR=/tmp/mako_gc
TOMB_DATE=$(date "+%Y-%m-%d")
TOMB_DIR=/manta/tombstone/$TOMB_DATE



# Mutables

NOW=""
SIGNATURE=""

ERROR="true"
FILE_COUNT=0
OBJECT_COUNT=0



## Functions

function fatal {
    local LNOW=`date "+%Y-%m-%dT%H:%M:%S.000Z"`
    echo "$LNOW: $(basename $0): fatal error: $*" >&2
    audit
    exit 1
}


function log {
    local LNOW=`date "+%Y-%m-%dT%H:%M:%S.000Z"`
    echo "$LNOW: $(basename $0): info: $*" >&2
}


# Since we use bunyan, this mimics a json structure.
function audit {
    local LNOW=`date "+%Y-%m-%dT%H:%M:%S.000Z"`
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
\"objectCount\":\"$OBJECT_COUNT\"\
}" >&2
}


function auditRow {
    local LNOW=`date "+%Y-%m-%dT%H:%M:%S.000Z"`
    echo "{\
\"audit\":true,\
\"name\":\"mako_gc\",\
\"level\":30,\
\"msg\":\"audit\",\
\"v\":0,\
\"time\":\"$LNOW\",\
\"pid\":$PID,\
\"hostname\":\"$HOSTNAME\",\
\"alreadyDeleted\":\"$1\",\
\"objectId\":\"$2\",\
\"tomb\":\"$3\",\
\"processed\":1\
}" >&2
}


function sign() {
    NOW=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    SIGNATURE=$(echo $NOW | tr -d '\n' | \
        openssl dgst -sha256 -sign $SSH_KEY | \
        openssl enc -e -a | tr -d '\n') \
        || fatal "unable to sign data"
}


function manta_get_no_fatal() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X GET \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 2>&1
}


function manta_get_to_file() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X GET \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 >$2 \
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

: ${MANTA_STORAGE_ID:?"Manta storage id must be set."}

log "starting gc"

GET_RES=`manta_get_no_fatal $MPATH`
if [[ $? -ne 0 ]]
then
    if [[ "$GET_RES" == *404* ]]
    then
        log "GC not ready yet: $MPATH $GET_RES"
        ERROR="false"
        audit
        exit 0
    else
        fatal "$MPATH $GET_RES"
    fi
fi

mkdir -p $TMP_DIR
mkdir -p $TOMB_DIR

while read -r JSON
do
    if [[ "$JSON" == "" ]]
    then
        break
    fi

    FILE=$(echo $JSON | json -a name)
    MFILE=$MPATH/$FILE
    LFILE=$TMP_DIR/$FILE
    manta_get_to_file $MFILE $LFILE

    log "Processing manta object $MFILE"

    while read -r LINE
    do
        #Filter out any lines that aren't meant for this storage node...
        if [[ ! $LINE =~ mako.*$MANTA_STORAGE_ID ]]
        then
            continue
        fi
        log "Processing $LINE"
        #Fields 3 and 4 are the owner and object ids, respectively.
        OBJECT=`echo "$LINE" | cut -f 3,4 | tr '\t' '/' | xargs -i echo /manta/{}`
        if [[ -f $OBJECT ]]
        then
            auditRow "false" "$OBJECT" "$TOMB_DIR"
            mv $OBJECT $TOMB_DIR
            [[ $? -eq 0 ]] || fatal "Couldn't move $OBJECT"
            ((OBJECT_COUNT++))
        else
            auditRow "true" "$OBJECT" "$TOMB_DIR"
        fi
    done < "$LFILE"

    rm $LFILE
    manta_delete $MFILE

    ((FILE_COUNT++))

    log "success processing $MFILE."
done <<< "$GET_RES"

ERROR="false"
audit
exit 0;
