import type { TextEditor, Uri } from 'vscode';
import { executeGitCommand } from '../commands/gitCommands.actions';
import { Commands } from '../constants';
import type { Container } from '../container';
import { GitUri } from '../git/gitUri';
import { SearchPattern } from '../git/search';
import { Logger } from '../logger';
import { showFileNotUnderSourceControlWarningMessage, showGenericErrorMessage } from '../messages';
import { command } from '../system/command';
import { filterMap } from '../system/iterable';
import { ActiveEditorCommand, getCommandUri } from './base';

export interface ShowCommitsInViewCommandArgs {
	refs?: string[];
	repoPath?: string;
}

@command()
export class ShowCommitsInViewCommand extends ActiveEditorCommand {
	constructor(private readonly container: Container) {
		super([Commands.ShowCommitInView, Commands.ShowCommitsInView]);
	}

	async execute(editor?: TextEditor, uri?: Uri, args?: ShowCommitsInViewCommandArgs) {
		args = { ...args };

		if (args.refs === undefined) {
			uri = getCommandUri(uri, editor);
			if (uri == null) return undefined;

			const gitUri = await GitUri.fromUri(uri);

			args.repoPath = gitUri.repoPath;

			if (editor != null) {
				try {
					// Check for any uncommitted changes in the range
					const blame = editor.document.isDirty
						? await this.container.git.getBlameForRangeContents(
								gitUri,
								editor.selection,
								editor.document.getText(),
						  )
						: await this.container.git.getBlameForRange(gitUri, editor.selection);
					if (blame === undefined) {
						return showFileNotUnderSourceControlWarningMessage('Unable to find commits');
					}

					args.refs = [...filterMap(blame.commits.values(), c => (c.isUncommitted ? undefined : c.ref))];
				} catch (ex) {
					Logger.error(ex, 'ShowCommitsInViewCommand', 'getBlameForRange');
					return showGenericErrorMessage('Unable to find commits');
				}
			} else {
				if (gitUri.sha == null) return undefined;

				args.refs = [gitUri.sha];
			}
		}

		return executeGitCommand({
			command: 'search',
			state: {
				repo: args?.repoPath,
				pattern: SearchPattern.fromCommits(args.refs),
				showResultsInSideBar: true,
			},
		});
	}
}
