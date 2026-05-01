#!/bin/bash
export CI=1

REPO_NAME=$(echo $GITHUB_REPOSITORY | cut -d'/' -f2)

pulumi login s3://tri-pulumi-state-us-east-1/$REPO_NAME

for i in $WORKDIRS; do
  if [ ! -d $i ]; then
    echo $i is not a directory, skipping..
    continue
  fi

  cd $i
  echo Destroying $i
  pulumi destroy --yes --non-interactive --color=never > destroy.out

  if [ ! $i == '.' ]; then
    cd ..
  fi
done

exit
