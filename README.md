# Custom-Actions
A monorepo consisting of our github actions modules

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

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Dependencies
        run: npm install

      - name: Run Tests
        run: npm test
```
````
