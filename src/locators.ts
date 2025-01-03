import * as vscode from "vscode";
import { CodeObjectLocator } from "./symbolization.js";
import { inspectPattern, output } from "./logs.js";
import * as path from "node:path";
import { inspect } from "node:util";

interface TimestampedFile {
    uri: vscode.Uri;
    timestamp: number;
}

/**
 * Describes a convention for where code object files are stored.
 */
interface FilesystemConvention {
    /**
     * The name of the convention.
     */
    readonly name: string;

    /**
     * Gets a list of possible code object locations in the specified directory.
     * @param projectDir the directory which is being searched
     */
    getUris(projectDir: vscode.Uri): Promise<vscode.Uri[]>;
}

/**
 * A convention for storing files which can be described as a list of relative paths.
 */
export class SimpleFilesystemConvention implements FilesystemConvention {
    constructor(
        public readonly name: string,
        /**
         * A list of code object paths relative to the directory being searched.
         */
        public readonly paths: string[],
    ) {}

    getUris(projectDir: vscode.Uri): Promise<vscode.Uri[]> {
        return Promise.resolve(
            this.paths.map((path) => vscode.Uri.joinPath(projectDir, path)),
        );
    }
}

/**
 * Finds code objects generated by cargo-v5, vexide's build tool.
 */
export class VexideFilesystemConvention implements FilesystemConvention {
    readonly name = "vexide";

    async getUris(projectDir: vscode.Uri): Promise<vscode.Uri[]> {
        const pattern = new vscode.RelativePattern(
            projectDir,
            "target/armv7a-vex-v5/{debug,release}/{examples/*,*}",
        );

        output.appendLine(
            `Using the following pattern to search for vexide files: ${inspectPattern(
                pattern,
            )}`,
        );

        const files = await vscode.workspace.findFiles(pattern);
        output.appendLine(
            `Found these files using vexide convention, before filtering out files with extensions:\n${files.join(
                "\n",
            )}`,
        );

        // ELF files generated by cargo never have file extensions or dashes in their names.
        const filtered = files.filter((file) => {
            const basename = path.basename(file.fsPath);
            return !/[\.\-]/.test(basename);
        });

        output.appendLine(
            `Found these files using vexide convention, after removing files with extensions:\n${filtered.join(
                "\n",
            )}`,
        );
        return filtered;
    }
}

/**
 * Finds code objects generated by VEXCode's Makefile.
 */
export class VEXCodeFilesystemConvention implements FilesystemConvention {
    readonly name = "VEXCode";

    async getUris(projectDir: vscode.Uri): Promise<vscode.Uri[]> {
        // VEXCode naming for ELF files is inconsistent, but they're always in `build/`.
        const pattern = new vscode.RelativePattern(projectDir, "build/*.elf");

        output.appendLine(
            `Using pattern to search for VEXCode files: ${inspectPattern(
                pattern,
            )}`,
        );
        return await vscode.workspace.findFiles(pattern);
    }
}

/**
 * Locates the most recent code objects in a project.
 */
export class RecentCodeObjectLocator implements CodeObjectLocator {
    constructor(
        /**
         * The filesystem conventions which the locator will consider while searching.
         */
        public conventions: FilesystemConvention[],
    ) {}

    get name() {
        return `Recent Files (${this.conventions
            .map((t) => t.name)
            .join(", ")})`;
    }

    async findObjectUris(folder: vscode.Uri): Promise<vscode.Uri[]> {
        const files = await Promise.all(
            this.conventions.map((convention) =>
                this.getTimestampedFilesWith(convention, folder),
            ),
        );

        return (
            files
                .flat()
                // Big timestamp (more recent) first
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((obj) => obj.uri)
        );
    }

    /**
     * Uses the specified convention to find files which actually exist on the filesystem.
     * @param convention the convention to use when searching
     * @param base the folder to search in
     * @returns an unsorted array of the timestamped files found with the convention's search strategy
     */
    async getTimestampedFilesWith(
        convention: FilesystemConvention,
        base: vscode.Uri,
    ): Promise<TimestampedFile[]> {
        const files = await Promise.all(
            (
                await convention.getUris(base)
            ).map(async (uri) => {
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    return {
                        uri,
                        timestamp: stat.mtime,
                    };
                } catch {
                    return;
                }
            }),
        );

        return files.filter((file) => file !== undefined);
    }
}
