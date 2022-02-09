import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import * as fs from 'fs-extra';
import type { BundleViolations, Dependency, CircularImportsViolations, NoticeViolations } from './model';
import { Notice } from './notice';
import { shell } from './shell';

/**
 * Bundling properties.
 */
export interface BundleProps {

  /**
   * Directory where the package to bundle is located at.
   */
  readonly packageDir: string;

  /**
   * Copyright string used when generating the NOTICE file.
   */
  readonly copyright: string;

  /**
   * External packages that cannot be bundled.
   *
   * These will remain a runtime dependency of the package.
   *
   * @default - no external references.
   */
  readonly externals?: string[];

  /**
   * External resources that need to be embedded in the bundle.
   *
   * These will be copied over to the appropriate paths before packaging.
   */
  readonly resources?: {[src: string]: string};

  /**
   * A list of licenses that are valid for bundling.
   * If any dependency contains a license not in this list, bundling will fail.
   *
   * @default - Default list
   */
  readonly licenses?: string[];

  /**
   * Packages matching this pattern will be excluded from attribution.
   */
  readonly dontAttribute?: string;
}

/**
 * Bundle class to validate and pack nodejs bundles.
 */
export class Bundle {

  private readonly manifest: any;
  private readonly script: string;
  private readonly entrypoint: string;

  private readonly externals: string[];
  private readonly resources: {[src: string]: string};
  private readonly validLicenses?: string[];
  private readonly packageDir: string;
  private readonly copyright: string;
  private readonly excludeFromAttribution?: string;

  private readonly dependencies: Dependency[];
  private readonly output: esbuild.OutputFile;

  private _notice?: Notice;

  constructor(props: BundleProps) {
    this.packageDir = props.packageDir;
    this.manifest = fs.readJsonSync(path.join(this.packageDir, 'package.json'));
    this.externals = props.externals ?? [];
    this.resources = props.resources ?? {};

    // resources must be defined relative to the package directory for them
    // to work across environments.
    for (const [src, dst] of Object.entries(this.resources)) {
      if (path.isAbsolute(src)) {
        throw new Error(`resource source must be a relative path (got ${src})`);
      }
      if (path.isAbsolute(dst)) {
        throw new Error(`resource destination must be a relative path (got ${dst})`);
      }
    }

    this.validLicenses = props.licenses;
    this.copyright = props.copyright;
    this.excludeFromAttribution = props.dontAttribute;

    const bin = this.bin();

    this.script = bin[0];
    this.entrypoint = bin[1];

    // without the dependencies, this object is pretty much
    // useless, so lets generate it of the bat.
    const { dependencies, output } = this.esbuild();
    this.dependencies = dependencies;
    this.output = output;
  }

  /**
   * Validate the state of the project with respect to bundling.
   *
   * This method will validate both circular imports and notice file attributions.
   * To validate only one or the other, use the `validateNotice` and `validateCircularImports`.
   *
   * It never throws an exception, instead it returns a report of violations. The Caller is responsible
   * for inspecting those violations and act accordingaly.
   *
   * If no violations are found, the return value will be undefined.
   */
  public validate(): BundleViolations | undefined {
    const importsViolations = this.validateCircularImports();
    const noticeViolations = this.notice.validate();

    if (!importsViolations && !noticeViolations) {
      return undefined;
    }

    return { notice: noticeViolations, imports: importsViolations };
  }

  /**
   * Validate the package (and its dependencies) don't exhibit circular imports.
   *
   * It never throws an exception, instead it return a rerpot of violations. The Caller is responsible
   * for inspecting those violations and act accordingaly.
   *
   * If no violations are found, the return value will be undefined
   */
  public validateCircularImports(): CircularImportsViolations | undefined {
    console.log('Validating circular imports');
    const packages = [this.packageDir, ...this.dependencies.map(d => d.path)];
    try {
      // we don't use the programatic API since it only offers an async API.
      // prefer to stay sync for now since its easier to integrate with other tooling.
      // will offer an async API further down the road.
      shell(`${require.resolve('madge/bin/cli.js')} --warning --no-color --no-spinner --circular --extensions js ${packages.join(' ')}`, { quiet: true });
      return undefined;
    } catch (e: any) {
      return { summary: e.stdout.toString() };
    }
  }

  public validateNotice(): NoticeViolations | undefined {
    console.log('Validating notice');
    return this.notice.validate();
  }

  public createNotice() {
    this.notice.create(this.copyright);
  }

  public fix() {
    console.log('Generating notice file');
    this.notice.create(this.copyright);
  }

  public pack(target: string) {

    // double check, make sure we don't package something invalid.
    const violations = this.validate();
    if (violations) {
      throw new Error('Unable to pack due to validation errors. Please run validate() to inspect them and fix.');
    }

    console.log('Creating package');

    if (!fs.existsSync(target)) {
      console.log(`✖ Target doesnt exist: ${target}`);
      process.exit(1);
    }

    if (!fs.lstatSync(target).isDirectory()) {
      console.log(`✖ Target must be a directory: ${target}`);
      process.exit(1);
    }

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), path.sep));
    try {
      fs.copySync(this.packageDir, workdir, { filter: n => !n.includes('node_modules') && !n.includes('.git') });

      const bundleManifest = { ...this.manifest };

      // move all 'dependencies' to 'devDependencies' so that npm doesn't install anything when consuming
      for (const [d, v] of Object.entries(this.manifest.dependencies)) {
        bundleManifest.devDependencies[d] = v;
      }
      bundleManifest.dependencies = {};

      // inject a new entrypoint referencing the bundle file
      const entrypointContent = ['#!/usr/bin/env node', `require('./${path.basename(this.output.path)}');`];
      const entrypointPath = path.join(path.dirname(this.entrypoint), 'entrypoint.bundle');
      bundleManifest.bin = { [this.script]: entrypointPath };

      fs.writeFileSync(path.join(workdir, entrypointPath), entrypointContent.join('\n'));
      fs.writeFileSync(path.join(workdir, 'package.json'), JSON.stringify(bundleManifest, null, 2));

      console.log('Writing bundle');
      fs.writeFileSync(this.output.path.replace(this.packageDir, workdir), this.output.contents);

      console.log('Copying resources');
      for (const [src, dst] of Object.entries(this.resources)) {
        fs.copySync(path.join(this.packageDir, src), path.join(workdir, dst), { recursive: true });
      }

      // create the tarball
      const tarball = shell('npm pack', { quiet: true, cwd: workdir }).trim();
      fs.copySync(path.join(workdir, tarball), path.join(target, tarball));

    } finally {
      fs.removeSync(workdir);
    }

  }

  private get notice(): Notice {
    if (this._notice) {
      return this._notice;
    }
    this._notice = new Notice({
      packageDir: this.packageDir,
      dependencies: this.dependencies,
      exclude: this.excludeFromAttribution,
      validLicenses: this.validLicenses,
    });
    return this._notice;
  }

  private findPackage(inputFile: string): string {

    function findPackageUp(dirname: string): string {
      const manifestPath = path.join(dirname, 'package.json');
      if (fs.existsSync(manifestPath)) {
        return dirname;
      }
      if (path.dirname(dirname) === dirname) {
        throw new Error('Unable to find package manifest');
      }
      return findPackageUp(path.dirname(dirname));
    }

    return findPackageUp(path.resolve(this.packageDir, path.dirname(inputFile)));
  }

  private createDependency(packageDir: string): Dependency {
    const manifestPath = path.join(packageDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, { encoding: 'utf-8' }));
    return { path: packageDir, name: manifest.name, version: manifest.version };
  }

  private esbuild(): { dependencies: Dependency[]; output: esbuild.OutputFile } {

    const bundle = esbuild.buildSync({
      entryPoints: [this.entrypoint],
      bundle: true,
      target: 'node12',
      platform: 'node',
      metafile: true,
      absWorkingDir: this.packageDir,
      external: this.externals,
      write: false,
      outfile: path.join(path.dirname(this.entrypoint), 'node-cli-bundle.js'),
      allowOverwrite: true,
    });

    if (!bundle.outputFiles || bundle.outputFiles.length === 0) {
      throw new Error('Bundling did not produce any output files');
    }

    if (bundle.outputFiles.length > 1) {
      throw new Error('Bundling produced multiple output files');
    }

    if (bundle.warnings.length) {
      // esbuild warnings are usually important, lets try to be strict here.
      // the warnings themselves are printed on screen.
      console.error(`✖ Found ${bundle.warnings.length} bundling warnings (See above)`);
      process.exit(1);
    }

    const outfile = bundle.outputFiles[0];

    const inputs = Object.keys(bundle.metafile!.outputs[path.relative(this.packageDir, outfile.path)].inputs);
    const packages = new Set(Array.from(inputs).map(i => this.findPackage(i)));
    const dependencies = Array.from(packages).map(p => this.createDependency(p)).filter(d => d.name !== this.manifest.name);
    return { dependencies, output: outfile };
  }

  private bin() {

    const bin: [string, string][] = Object.entries(this.manifest.bin ?? {});
    if (bin.length === 0) {
      console.error('✖ No entry-points detected. You must configure exactly one entrypoint in the \'bin\' section of your manifest');
      process.exit(1);
    }
    if (bin.length > 1) {
      console.error('✖ Multiple entry-points detected. You must configure exactly one entrypoint in the \'bin\' section of your manifest');
      process.exit(1);
    }

    return bin[0];
  }
}
