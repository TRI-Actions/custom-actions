#!/bin/bash
export CI=1

for i in $WORKDIRS; do
  if [ ! -d $i ]; then
    echo $i is not a directory, skipping..
    continue
  fi

  options="--auto-approve --no-color"
  if [ "$UPDATE_STATE" == "true" ]; then
    options+=" --refresh-only"
  fi

  cd $i
  echo Deploying for $i
  cdktf deploy $options > deploy.out

  if [ ! $i == '.' ]; then
    cd ..
  fi
done

exit
