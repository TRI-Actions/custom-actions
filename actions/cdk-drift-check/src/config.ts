import { getInput } from '@actions/core';

const required = (value: string): string => {
  if (value === '') {
    throw new Error(`Required action input ${value} was empty.`);
  }
  return value;
};

function parseConfig(): any {
  return {
    region: getInput('region'),
    account: getInput('account'),
    stack_name: required(getInput('stack_name'))
  };
};

export const config = parseConfig();
