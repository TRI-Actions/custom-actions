import { config } from './config';
import { sleep, catchErrors } from './utils';
import { setOutput, setFailed } from '@actions/core';
import {
	CloudFormationClient,
	CloudFormationClientConfig,
	DescribeStacksCommand,
	DetectStackDriftCommand,
	DescribeStackDriftDetectionStatusCommand,
	DescribeStackResourceDriftsCommand,
	StackResourceDriftStatus
} from '@aws-sdk/client-cloudformation';
import { STSClient, AssumeRoleCommand, AssumeRoleCommandOutput } from "@aws-sdk/client-sts";

const stackName = config.stack_name
const account = config.account
const region = config.region

const allowedDdStatusList: string[] = [
	'CREATE_COMPLETE',
	'UPDATE_COMPLETE',
	'UPDATE_ROLLBACK_COMPLETE',
	'UPDATE_ROLLBACK_FAILED',
];

function main () {
	if (!account) {
		console.info('Running with credentials on host!')
		run()
	} else {
		const roleArn = `arn:aws:iam::${account}:role/GithubActionsCrossAccountRole`
		const stsClient = new STSClient({ region: region });
		const stsInput = {
  		RoleArn: roleArn,
  		RoleSessionName: "github_actions"
		}

		const stsCommand = new AssumeRoleCommand(stsInput);
		stsClient.send(stsCommand).then(res => {
			console.info(`Running with assumed role: ${res.AssumedRoleUser?.Arn}`);
			run(res);
		});
	}
}

async function run(creds?: AssumeRoleCommandOutput) {
	let clientConfig: CloudFormationClientConfig = {
		region: region,
	}
	if (creds) {
		clientConfig["credentials"] = {
			accessKeyId: creds.Credentials!.AccessKeyId!,
			secretAccessKey: creds.Credentials!.SecretAccessKey!,
			sessionToken: creds.Credentials!.SessionToken!
		}
	}
	const cfnClient = new CloudFormationClient(clientConfig);

	const getStack = async (stackName: string) => {
		const input = {
			StackName: stackName,
		};
		const command = new DescribeStacksCommand(input);
		const response = await cfnClient.send(command);

		return response;
	}

	const detectDrift = async (stackName: string) => {
		console.info('Detection started');
		const input = {
			StackName: stackName,
		};
		const command = new DetectStackDriftCommand(input);
		const response = await cfnClient.send(command);

		return response.StackDriftDetectionId;
	}

	const getDriftStatus = async (detectionId: string) => {
		const input = {
			StackDriftDetectionId: detectionId,
		};
		const command = new DescribeStackDriftDetectionStatusCommand(input);
		let response = await cfnClient.send(command);

		while (response["DetectionStatus"] == "DETECTION_IN_PROGRESS") {
			console.info(response["DetectionStatus"])
			await sleep(5000);
			response = await cfnClient.send(command);
		}

		return response;
	}

	const getDriftedResources = async (stackName: string) => {
		const input = {
			StackName: stackName,
			StackResourceDriftStatusFilters: [StackResourceDriftStatus.DELETED, StackResourceDriftStatus.MODIFIED]
		};

		const command = new DescribeStackResourceDriftsCommand(input);
		const response = await cfnClient.send(command);

		return response.StackResourceDrifts;
	}

	console.info('Check if the stack exists');
	const [err, stacksOutput] = await catchErrors(getStack(stackName));
	if (err) {
		if (err.message.includes(`Stack with id ${stackName} does not exist`)) {
			console.info('Stack does not exist, drift check will be skipped!')
			return;
		}
		setFailed(err.message);
	}

	if (
	  stacksOutput.Stacks &&
	  stacksOutput.Stacks.length > 0 &&
	  stacksOutput.Stacks[0].StackName == stackName
	) {
	  console.info('Stack exists, now check for the stack status');
	  if (
	    stacksOutput.Stacks[0].StackStatus &&
	    allowedDdStatusList.includes(stacksOutput.Stacks[0].StackStatus)
	  ) {
	    console.info('Stack Status allows for drift detection');
			const [err, driftResp] = await catchErrors(detectDrift(stackName));
			const [statusErr, driftStatus] = await catchErrors(getDriftStatus(driftResp));

			if (err || statusErr) {
				err ? console.error(err) : console.error(statusErr);
			}

			console.info(driftStatus["StackDriftStatus"]);
			if (driftStatus["StackDriftStatus"] == 'DRIFTED') {
				const [detailsErr, details] = await catchErrors(getDriftedResources(stackName));
				if (detailsErr) { console.error(detailsErr) };
				setOutput("details", JSON.stringify(details));
			} else {
				setOutput("details", [])
			}
	    setOutput("result", driftStatus["StackDriftStatus"]);
	  } else {
	    console.error('Stack status does not allow for drift detection');
	  }
	} else {
	  const message = 'Stack does not exist, drift check skipped!';
	  console.info(message);
	}
}

main();
