export async function catchErrors(promise: Promise<any>) {
  try {
		const data = await promise;
		return [null, data];
	} catch (err) {
		return [err];
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
