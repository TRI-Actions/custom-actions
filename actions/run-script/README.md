# Run Script

A composite custom github action that runs given script in different languages and sets the output to output.txt

## Parameters

| Name          | Description                                        | Required | Default         |
|---------------|----------------------------------------------------|----------|-----------------|
| path           | Path of the script/ directory that the scripts are located                                | No       | `.`             |

## Example

```yaml
jobs:
  test:
    runs-on: [self-hosted]

    steps:
    - name: Check out repository code
      uses: actions/checkout@v3

    - name: Run script
      id: run_script
      uses: TRI-Actions/custom-actions/actions/run-script@main
      with:
        path: "."

    - name: output log location
      run: echo "Logs are located at: ${{ steps.run_script.outputs.run-script-logs }}"

```
