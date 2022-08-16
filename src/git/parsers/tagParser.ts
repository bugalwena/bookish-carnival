import { debug } from '../../system/decorators/log';
import { GitTag } from '../models/tag';

const tagRegex = /^<n>(.+)<\*r>(.*)<r>(.*)<d>(.*)<ad>(.*)<s>(.*)$/gm;

// Using %x00 codes because some shells seem to try to expand things if not
const lb = '%3c'; // `%${'<'.charCodeAt(0).toString(16)}`;
const rb = '%3e'; // `%${'>'.charCodeAt(0).toString(16)}`;

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class GitTagParser {
	static defaultFormat = [
		`${lb}n${rb}%(refname)`, // tag name
		`${lb}*r${rb}%(*objectname)`, // ref
		`${lb}r${rb}%(objectname)`, // ref
		`${lb}d${rb}%(creatordate:iso8601)`, // created date
		`${lb}ad${rb}%(authordate:iso8601)`, // author date
		`${lb}s${rb}%(subject)`, // message
	].join('');

	@debug({ args: false, singleLine: true })
	static parse(data: string, repoPath: string): GitTag[] | undefined {
		if (!data) return undefined;

		const tags: GitTag[] = [];

		let name;
		let ref1;
		let ref2;
		let date;
		let commitDate;
		let message;

		let match;
		do {
			match = tagRegex.exec(data);
			if (match == null) break;

			[, name, ref1, ref2, date, commitDate, message] = match;

			// Strip off refs/tags/
			name = name.substr(10);

			tags.push(
				new GitTag(
					repoPath,
					name,
					// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
					` ${ref1 || ref2}`.substr(1),
					// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
					` ${message}`.substr(1),
					date ? new Date(date) : undefined,
					commitDate == null || commitDate.length === 0 ? undefined : new Date(commitDate),
				),
			);
		} while (true);

		return tags;
	}
}
