import type { ConfigurationChangeEvent } from 'vscode';
import { Disposable } from 'vscode';
import type { AutolinkReference, AutolinkType } from '../configuration';
import { configuration } from '../configuration';
import { GlyphChars } from '../constants';
import type { Container } from '../container';
import { IssueOrPullRequest } from '../git/models/issue';
import type { GitRemote } from '../git/models/remote';
import type { RemoteProviderReference } from '../git/models/remoteProvider';
import { Logger } from '../logger';
import { fromNow } from '../system/date';
import { debug } from '../system/decorators/log';
import { encodeUrl } from '../system/encoding';
import { every, join, map } from '../system/iterable';
import type { PromiseCancelledErrorWithId } from '../system/promise';
import { PromiseCancelledError, raceAll } from '../system/promise';
import { escapeMarkdown, escapeRegex, getSuperscript } from '../system/string';

const emptyAutolinkMap = Object.freeze(new Map<string, Autolink>());

const numRegex = /<num>/g;

export interface Autolink {
	provider?: RemoteProviderReference;
	id: string;
	prefix: string;
	title?: string;
	url: string;

	type?: AutolinkType;
	description?: string;
}

export interface CacheableAutolinkReference extends AutolinkReference {
	linkify?: ((text: string, markdown: boolean, footnotes?: Map<number, string>) => string) | null;
	messageMarkdownRegex?: RegExp;
	messageRegex?: RegExp;
}

export interface DynamicAutolinkReference {
	linkify: (text: string, markdown: boolean, footnotes?: Map<number, string>) => string;
	parse: (text: string, autolinks: Map<string, Autolink>) => void;
}

function isDynamic(ref: AutolinkReference | DynamicAutolinkReference): ref is DynamicAutolinkReference {
	return !('prefix' in ref) && !('url' in ref);
}

function isCacheable(ref: AutolinkReference | DynamicAutolinkReference): ref is CacheableAutolinkReference {
	return 'prefix' in ref && ref.prefix != null && 'url' in ref && ref.url != null;
}

export class Autolinks implements Disposable {
	protected _disposable: Disposable | undefined;
	private _references: CacheableAutolinkReference[] = [];

	constructor(private readonly container: Container) {
		this._disposable = Disposable.from(configuration.onDidChange(this.onConfigurationChanged, this));

		this.onConfigurationChanged();
	}

	dispose() {
		this._disposable?.dispose();
	}

	private onConfigurationChanged(e?: ConfigurationChangeEvent) {
		if (configuration.changed(e, 'autolinks')) {
			const autolinks = configuration.get('autolinks');
			// Since VS Code's configuration objects are live we need to copy them to avoid writing back to the configuration
			this._references =
				autolinks
					?.filter(a => a.prefix && a.url)
					/**
					 * Only allow properties defined by {@link AutolinkReference}
					 */
					?.map(a => ({
						prefix: a.prefix,
						url: a.url,
						title: a.title,
						alphanumeric: a.alphanumeric,
						ignoreCase: a.ignoreCase,
						type: a.type,
						description: a.description,
					})) ?? [];
		}
	}

	@debug<Autolinks['getAutolinks']>({
		args: {
			0: '<message>',
			1: false,
		},
	})
	getAutolinks(message: string, remote?: GitRemote): Map<string, Autolink> {
		const provider = remote?.provider;
		// If a remote is provided but there is no provider return an empty set
		if (remote != null && remote.provider == null) return emptyAutolinkMap;

		const autolinks = new Map<string, Autolink>();

		let match;
		let num;
		for (const ref of provider?.autolinks ?? this._references) {
			if (!isCacheable(ref)) {
				if (isDynamic(ref)) {
					ref.parse(message, autolinks);
				}
				continue;
			}

			if (ref.messageRegex == null) {
				ref.messageRegex = new RegExp(
					`(?<=^|\\s|\\(|\\\\\\[)(${escapeRegex(ref.prefix)}([${ref.alphanumeric ? '\\w' : '0-9'}]+))\\b`,
					ref.ignoreCase ? 'gi' : 'g',
				);
			}

			do {
				match = ref.messageRegex.exec(message);
				if (match == null) break;

				[, , num] = match;

				autolinks.set(num, {
					provider: provider,
					id: num,
					prefix: ref.prefix,
					url: ref.url?.replace(numRegex, num),
					title: ref.title?.replace(numRegex, num),

					type: ref.type,
					description: ref.description?.replace(numRegex, num),
				});
			} while (true);
		}

		return autolinks;
	}

	async getLinkedIssuesAndPullRequests(
		message: string,
		remote: GitRemote,
		options?: { autolinks?: Map<string, Autolink>; timeout?: never },
	): Promise<Map<string, IssueOrPullRequest | undefined> | undefined>;
	async getLinkedIssuesAndPullRequests(
		message: string,
		remote: GitRemote,
		options: { autolinks?: Map<string, Autolink>; timeout: number },
	): Promise<
		| Map<
				string,
				| IssueOrPullRequest
				| PromiseCancelledErrorWithId<string, Promise<IssueOrPullRequest | undefined>>
				| undefined
		  >
		| undefined
	>;
	@debug<Autolinks['getLinkedIssuesAndPullRequests']>({
		args: {
			0: '<message>',
			1: false,
			2: options => `autolinks=${options?.autolinks != null}, timeout=${options?.timeout}`,
		},
	})
	async getLinkedIssuesAndPullRequests(
		message: string,
		remote: GitRemote,
		options?: { autolinks?: Map<string, Autolink>; timeout?: number },
	) {
		if (!remote.hasRichProvider()) return undefined;

		const { provider } = remote;
		const connected = provider.maybeConnected ?? (await provider.isConnected());
		if (!connected) return undefined;

		let autolinks = options?.autolinks;
		if (autolinks == null) {
			autolinks = this.getAutolinks(message, remote);
		}

		if (autolinks.size === 0) return undefined;

		const issuesOrPullRequests = await raceAll(
			autolinks.keys(),
			id => provider.getIssueOrPullRequest(id),
			options?.timeout,
		);
		if (issuesOrPullRequests.size === 0 || every(issuesOrPullRequests.values(), pr => pr == null)) {
			return undefined;
		}

		return issuesOrPullRequests;
	}

	@debug<Autolinks['linkify']>({
		args: {
			0: '<text>',
			2: remotes => remotes?.length,
			3: issuesOrPullRequests => issuesOrPullRequests?.size,
			4: footnotes => footnotes?.size,
		},
	})
	linkify(
		text: string,
		markdown: boolean,
		remotes?: GitRemote[],
		issuesOrPullRequests?: Map<string, IssueOrPullRequest | PromiseCancelledError | undefined>,
		footnotes?: Map<number, string>,
	) {
		for (const ref of this._references) {
			if (this.ensureAutolinkCached(ref, issuesOrPullRequests)) {
				if (ref.linkify != null) {
					text = ref.linkify(text, markdown, footnotes);
				}
			}
		}

		if (remotes != null && remotes.length !== 0) {
			for (const r of remotes) {
				if (r.provider == null) continue;

				for (const ref of r.provider.autolinks) {
					if (this.ensureAutolinkCached(ref, issuesOrPullRequests)) {
						if (ref.linkify != null) {
							text = ref.linkify(text, markdown, footnotes);
						}
					}
				}
			}
		}

		return text;
	}

	private ensureAutolinkCached(
		ref: CacheableAutolinkReference | DynamicAutolinkReference,
		issuesOrPullRequests?: Map<string, IssueOrPullRequest | PromiseCancelledError | undefined>,
	): ref is CacheableAutolinkReference | DynamicAutolinkReference {
		if (isDynamic(ref)) return true;
		if (!ref.prefix || !ref.url) return false;

		try {
			if (ref.messageMarkdownRegex == null) {
				ref.messageMarkdownRegex = new RegExp(
					`(?<=^|\\s|\\(|\\\\\\[)(${escapeRegex(escapeMarkdown(ref.prefix))}([${
						ref.alphanumeric ? '\\w' : '0-9'
					}]+))\\b`,
					ref.ignoreCase ? 'gi' : 'g',
				);
			}

			if (issuesOrPullRequests == null || issuesOrPullRequests.size === 0) {
				const replacement = `[$1](${encodeUrl(ref.url.replace(numRegex, '$2'))}${
					ref.title ? ` "${ref.title.replace(numRegex, '$2')}"` : ''
				})`;
				ref.linkify = (text: string, markdown: boolean) =>
					markdown ? text.replace(ref.messageMarkdownRegex!, replacement) : text;

				return true;
			}

			ref.linkify = (text: string, markdown: boolean, footnotes?: Map<number, string>) => {
				const includeFootnotes = footnotes == null;
				let index;

				if (markdown) {
					return text.replace(ref.messageMarkdownRegex!, (_substring, linkText, num) => {
						const issue = issuesOrPullRequests?.get(num);

						const issueUrl = encodeUrl(ref.url.replace(numRegex, num));

						let title = '';
						if (ref.title) {
							title = ` "${ref.title.replace(numRegex, num)}`;

							if (issue != null) {
								if (issue instanceof PromiseCancelledError) {
									title += `\n${GlyphChars.Dash.repeat(2)}\nDetails timed out`;
								} else {
									const issueTitle = issue.title.replace(/([")\\])/g, '\\$1').trim();

									if (footnotes != null) {
										index = footnotes.size + 1;
										footnotes.set(
											index,
											`${IssueOrPullRequest.getMarkdownIcon(
												issue,
											)} [**${issueTitle}**](${issueUrl}${title}")\\\n${GlyphChars.Space.repeat(
												5,
											)}${linkText} ${issue.closed ? 'closed' : 'opened'} ${fromNow(
												issue.closedDate ?? issue.date,
											)}`,
										);
									}

									title += `\n${GlyphChars.Dash.repeat(2)}\n${issueTitle}\n${
										issue.closed ? 'Closed' : 'Opened'
									}, ${fromNow(issue.closedDate ?? issue.date)}`;
								}
							}
							title += '"';
						}

						return `[${linkText}](${issueUrl}${title})`;
					});
				}

				text = text.replace(ref.messageRegex!, (_substring, linkText: string, num) => {
					const issue = issuesOrPullRequests?.get(num);
					if (issue == null) return linkText;

					if (footnotes === undefined) {
						footnotes = new Map<number, string>();
					}

					index = footnotes.size + 1;
					footnotes.set(
						index,
						`${linkText}: ${
							issue instanceof PromiseCancelledError
								? 'Details timed out'
								: `${issue.title}  ${GlyphChars.Dot}  ${issue.closed ? 'Closed' : 'Opened'}, ${fromNow(
										issue.closedDate ?? issue.date,
								  )}`
						}`,
					);
					return `${linkText}${getSuperscript(index)}`;
				});

				return includeFootnotes && footnotes != null && footnotes.size !== 0
					? `${text}\n${GlyphChars.Dash.repeat(2)}\n${join(
							map(footnotes, ([i, footnote]) => `${getSuperscript(i)} ${footnote}`),
							'\n',
					  )}`
					: text;
			};
		} catch (ex) {
			Logger.error(
				ex,
				`Failed to create autolink generator: prefix=${ref.prefix}, url=${ref.url}, title=${ref.title}`,
			);
			ref.linkify = null;
		}

		return true;
	}
}
