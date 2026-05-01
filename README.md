# Custom-Actions
A monorepo consisting of our github actions modules. Each directory has its own readme going into further detail with how to use each directory

All repos can be used by creating the following github actions workflow:

````yaml
name: PR Workflow

on:
  pull_request:
    branches:
      - main

jobs:
  build:
    name: Run Checks on PR
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Trigger Custom Action
        uses: TRI-Actions/custom-actions/actions/<Action_Name>@main
        with:
          # Variables for custom-action here
````
