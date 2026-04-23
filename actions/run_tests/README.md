# run_tests

This repo will create a docker container with your repo and execute the scripts specified

```
inputs:
  test_path:
    description: "Path to the directories holding the bash scripts that will be executed with bash"
    required: true
  starting_file:
    description: "file name for where the container will start executing from"
    required: true
  local_container_path:
    description: "Path of the container to deploy"
    required: true
  container_dir:
    description: "Path where to deploy files inside container"
```

## How to use in Actions Workflow

```
  jobs:
    pipeline:
      runs-on: ubuntu-latest
      name: my-pipeline
      permissions: write-all
   
      steps:
        - name: run composite module
          uses: TRI-Actions/run_tests@main
          with:
            test_path: /my_path
            starting_file: dockerfile_path
            local_container_path: /local_docker
            container_dir: /test_path
```