import AggregateError from 'aggregate-error';

export default async function pMap(
	iterable,
	mapper,
	{
		concurrency = Number.POSITIVE_INFINITY,
		stopOnError = true
	} = {}
) {
	return new Promise((resolve, reject) => {
		if (typeof mapper !== 'function') {
			throw new TypeError('Mapper function is required');
		}

		if (!((Number.isSafeInteger(concurrency) || concurrency === Number.POSITIVE_INFINITY) && concurrency >= 1)) {
			throw new TypeError(`Expected \`concurrency\` to be an integer from 1 and up or \`Infinity\`, got \`${concurrency}\` (${typeof concurrency})`);
		}

		const result = [];
		const errors = [];
		const skippedIndexes = [];
		let isRejected = false;
		let isIterableDone = false;
		let resolvingCount = 0;
		let currentIndex = 0;
		let isAsyncIterator = false;
		let iterator;

		if (iterable[Symbol.iterator] === undefined) {
			// We've got an async iterable
			iterator = iterable[Symbol.asyncIterator]();
			isAsyncIterator = true;
		} else {
			iterator = iterable[Symbol.iterator]();
		}

		const next = async () => {
			if (isRejected) {
				return;
			}

			const nextItem = isAsyncIterator ? await iterator.next() : iterator.next();

			const index = currentIndex;
			currentIndex++;

			if (nextItem.done) {
				isIterableDone = true;

				if (resolvingCount === 0) {
					if (!stopOnError && errors.length > 0) {
						reject(new AggregateError(errors));
					} else {
						for (const skippedIndex of skippedIndexes) {
							result.splice(skippedIndex, 1);
						}

						resolve(result);
					}
				}

				return;
			}

			resolvingCount++;

			// Intentionally not awaited
			(async () => {
				try {
					const element = await nextItem.value;

					if (isRejected) {
						return;
					}

					const value = await mapper(element, index);

					if (value === pMapSkip) {
						skippedIndexes.push(index);
					} else {
						result[index] = value;
					}

					resolvingCount--;
					await next();
				} catch (error) {
					if (stopOnError) {
						isRejected = true;
						reject(error);
					} else {
						errors.push(error);
						resolvingCount--;

						// FIXME: This has no try/catch block around it
						await next();
					}
				}
			})();
		};

		// Create the concurrent runners in a detached (non-awaited)
		// promise.  We need this so we can await the next() calls
		// to stop creating runners before hitting the concurrency limit
		// if the iterable has already been marked as done.
		// NOTE: We *must* do this for async iterators otherwise we'll spin up
		// infinite next() calls by default and never start the event loop.
		(async () => {
			for (let index = 0; index < concurrency; index++) {
				try {
					// Exceptions happen here if .next on the iterable throws
					// In that case we can't really continue regardless of stopOnError state
					// We must await this else initial iteration of an async iterable
					// will loop forever setting up runners for iterable items that do not
					// actually exist (since concurrency limit is defaulted to Infinity)
					// Note: for sync iterables this will have no negative impact
					// eslint-disable-next-line no-await-in-loop
					await next();
				} catch (error) {
					if (!isRejected) {
						isRejected = true;
						reject(error);
					}

					break;
				}

				if (isIterableDone) {
					break;
				}
			}
		})();
	});
}

export const pMapSkip = Symbol('skip');
