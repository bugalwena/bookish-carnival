import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { GlyphChars } from '../../constants';
import { GitUri } from '../../git/gitUri';
import type { NamedRef } from '../../storage';
import type { SearchAndCompareView, SearchAndCompareViewNode } from '../searchAndCompareView';
import { ContextValues, ViewNode } from './viewNode';

interface RepoRef {
	label: string;
	repoPath: string;
	ref: string | NamedRef;
}

export class ComparePickerNode extends ViewNode<SearchAndCompareView> {
	readonly order: number = Date.now();
	readonly pinned: boolean = false;

	constructor(view: SearchAndCompareView, parent: SearchAndCompareViewNode, public readonly selectedRef: RepoRef) {
		super(GitUri.unknown, view, parent);
	}

	get canDismiss(): boolean {
		return true;
	}

	getChildren(): ViewNode[] {
		return [];
	}

	getTreeItem(): TreeItem {
		const selectedRef = this.selectedRef;
		const repoPath = selectedRef?.repoPath;

		let description;
		if (repoPath !== undefined) {
			if (this.view.container.git.repositoryCount > 1) {
				const repo = this.view.container.git.getRepository(repoPath);
				description = repo?.formattedName ?? repoPath;
			}
		}

		let item;
		if (selectedRef == null) {
			item = new TreeItem(
				'Compare <branch, tag, or ref> with <branch, tag, or ref>',
				TreeItemCollapsibleState.None,
			);
			item.contextValue = ContextValues.ComparePicker;
			item.description = description;
			item.tooltip = `Click to select or enter a reference for compare${GlyphChars.Ellipsis}`;
			item.command = {
				title: `Compare${GlyphChars.Ellipsis}`,
				command: this.view.getQualifiedCommand('selectForCompare'),
			};
		} else {
			item = new TreeItem(
				`Compare ${selectedRef.label} with <branch, tag, or ref>`,
				TreeItemCollapsibleState.None,
			);
			item.contextValue = ContextValues.ComparePickerWithRef;
			item.description = description;
			item.tooltip = `Click to compare ${selectedRef.label} with${GlyphChars.Ellipsis}`;
			item.command = {
				title: `Compare ${selectedRef.label} with${GlyphChars.Ellipsis}`,
				command: this.view.getQualifiedCommand('compareWithSelected'),
			};
		}

		return item;
	}
}
