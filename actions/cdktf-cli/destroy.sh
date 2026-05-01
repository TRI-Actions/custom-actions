#!/bin/bash
export CI=1

for i in $WORKDIRS; do
  if [ ! -d $i ]; then
    echo $i is not a directory, skipping..
    continue
  fi

  cd $i
  echo Destroying $i
  cdktf destroy --auto-approve --no-color > destroy.out

  if [ ! $i == '.' ]; then
    cd ..
  fi
done

exit
