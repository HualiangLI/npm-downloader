#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const semver = require('semver');
const chalk = require('chalk');
const cliProgress = require('cli-progress'); // 进度条库
const { program } = require('commander'); // 命令行参数解析库

// 常量
const REGISTRY_URL = 'https://registry.npmmirror.com';
const DOWNLOAD_DIR = path.join(process.cwd(), 'npm-packages');
const LOG_FILE = path.join(process.cwd(), 'download.log'); // 日志文件改为 .log 后缀
const CONCURRENCY = 5; // 并发下载数

// 商用友好许可证列表
const COMMERCIAL_FRIENDLY_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

// 初始化进度条
const progressBar = new cliProgress.SingleBar({
  format: '{bar} {percentage}% | {value}/{total} bytes | {filename}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true,
});

// 全局变量：记录下载的包及其依赖
const downloadedPackages = new Set(); // 避免重复下载
const packageList = []; // 包及其版本号列表
const dependencyTree = {}; // 依赖树
const licenseWarnings = []; // 许可证警告信息

/**
 * 删除下载目录（如果存在）
 */
function clearDownloadDirectory() {
  if (fs.existsSync(DOWNLOAD_DIR)) {
    console.log(chalk.yellow(`Clearing download directory: ${DOWNLOAD_DIR}`));
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  }
}

/**
 * 创建下载目录
 */
function createDownloadDirectory() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    console.log(chalk.yellow(`Creating download directory: ${DOWNLOAD_DIR}`));
    fs.mkdirSync(DOWNLOAD_DIR);
  }
}

/**
 * 解析包名和版本号
 * @param {string} packageString - 包名和版本号字符串（如 "@element-plus/icons-vue" 或 "@element-plus/icons-vue@2.3.0"）
 * @returns {object} - 包名和版本号
 */
function parsePackageString(packageString) {
  // 匹配作用域包名和版本号
  const match = packageString.match(/^(@[^\/]+\/[^@]+)(?:@(.+))?$/);
  if (!match) {
    // 如果不是作用域包，尝试匹配普通包名
    const [name, version] = packageString.split('@');
    if (!name) {
      throw new Error(`Invalid package string: ${packageString}`);
    }
    return { name, version: version || 'latest' };
  }

  const [, name, version] = match;
  return { name, version: version || 'latest' };
}

/**
 * 获取包的元数据
 * @param {string} packageName - 包名
 * @param {string} version - 版本号
 * @returns {object} - 包的元数据
 */
async function getPackageMetadata(packageName, version) {
  const url = `${REGISTRY_URL}/${packageName}/${version}`;
  const response = await axios.get(url);
  return response.data;
}

/**
 * 检查许可证是否为商用友好
 * @param {string} license - 许可证
 * @returns {boolean} - 是否为商用友好许可证
 */
function isCommercialFriendly(license) {
  if (!license) return false;
  return COMMERCIAL_FRIENDLY_LICENSES.includes(license);
}

/**
 * 下载 .tgz 文件并显示进度
 * @param {string} packageName - 包名
 * @param {string} version - 版本号
 * @param {string} tarballUrl - .tgz 文件的 URL
 */
async function downloadTarball(packageName, version, tarballUrl) {
  const fileName = `${packageName}-${version}.tgz`.replace(/\//g, '-'); // 替换斜杠为横杠
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  // 如果文件已存在，跳过下载
  if (fs.existsSync(filePath)) {
    console.log(chalk.yellow(`Skipping ${fileName} (already downloaded)`));
    return;
  }

  // 开始下载
  const response = await axios({
    url: tarballUrl,
    method: 'GET',
    responseType: 'stream',
    onDownloadProgress: (progressEvent) => {
      const { loaded, total } = progressEvent;
      if (total === 0) {
        console.log(chalk.yellow(`No Content-Length header, using loaded bytes: ${loaded}`));
        return;
      }
      progressBar.update(loaded, { total, filename: fileName });
    },
  });

  // 检查 Content-Length
  const contentLength = response.headers['content-length'];
  if (!contentLength) {
    console.log(chalk.yellow(`No Content-Length header for ${fileName}`));
  }

  // 初始化进度条
  progressBar.start(contentLength || 100, 0, { filename: fileName });

  // 将数据写入文件
  response.data.pipe(fs.createWriteStream(filePath));

  return new Promise((resolve, reject) => {
    response.data.on('end', () => {
      progressBar.stop();
      resolve();
    });
    response.data.on('error', (err) => {
      progressBar.stop();
      reject(err);
    });
  });
}

/**
 * 递归获取所有依赖
 * @param {object} dependencies - 依赖对象
 * @returns {object} - 所有依赖及其版本号
 */
function getAllDependencies(dependencies) {
  const allDependencies = {};

  for (const [name, versionRange] of Object.entries(dependencies)) {
    // 标准化版本号
    const normalizedVersion = semver.valid(semver.coerce(versionRange));
    if (normalizedVersion) {
      allDependencies[name] = normalizedVersion;
    } else {
      console.warn(chalk.yellow(`Skipping invalid version range: ${name}@${versionRange}`));
    }
  }

  return allDependencies;
}

/**
 * 递归下载包及其依赖
 * @param {string} packageName - 包名
 * @param {string} version - 版本号
 * @param {string} parent - 父包名（用于构建依赖树）
 */
async function downloadPackageAndDependencies(packageName, version, parent = null) {
  const packageKey = `${packageName}@${version}`;

  // 如果已经下载过，跳过
  if (downloadedPackages.has(packageKey)) {
    return;
  }
  downloadedPackages.add(packageKey);

  // 记录包及其版本号
  packageList.push(packageKey);

  // 构建依赖树
  if (parent) {
    if (!dependencyTree[parent]) {
      dependencyTree[parent] = [];
    }
    dependencyTree[parent].push(packageKey);
  }

  try {
    // 获取主包的元数据
    const metadata = await getPackageMetadata(packageName, version);
    const dependencies = metadata.dependencies || {};

    // 检查许可证
    const license = metadata.license;
    if (!isCommercialFriendly(license)) {
      const warning = `WARNING: ${packageKey} uses a non-commercial-friendly license: ${license || 'Unknown'}`;
      licenseWarnings.push(warning);
      console.log(chalk.red(warning));
    }

    // 下载主包的 .tgz 文件
    await downloadTarball(packageName, version, metadata.dist.tarball);

    // 获取所有依赖
    const allDependencies = getAllDependencies(dependencies);

    // 并发下载所有依赖
    const downloadPromises = Object.entries(allDependencies).map(([name, version]) =>
      downloadPackageAndDependencies(name, version, packageKey)
    );

    // 控制并发数
    const batchSize = CONCURRENCY;
    for (let i = 0; i < downloadPromises.length; i += batchSize) {
      const batch = downloadPromises.slice(i, i + batchSize);
      await Promise.all(batch);
    }
  } catch (error) {
    console.error(chalk.red(`Error downloading ${packageKey}:`, error.message));
  }
}

/**
 * 生成树形依赖结构
 * @param {string} packageKey - 包名及其版本号
 * @param {number} depth - 当前深度
 * @returns {string} - 树形结构字符串
 */
function buildDependencyTree(packageKey, depth = 0) {
  let tree = '  '.repeat(depth) + `- ${packageKey}\n`;
  if (dependencyTree[packageKey]) {
    dependencyTree[packageKey].forEach((child) => {
      tree += buildDependencyTree(child, depth + 1);
    });
  }
  return tree;
}

/**
 * 主函数
 */
async function main() {
  // 解析命令行参数
  program
    .option('-c, --clear', 'Clear the download directory before starting')
    .arguments('<packages...>')
    .action(async (packages) => {
      // 清空下载目录（如果指定了 --clear 参数）
      if (program.opts().clear) {
        clearDownloadDirectory();
      }
      createDownloadDirectory();

      // 解析包名和版本号
      const parsedPackages = packages.map(parsePackageString);

      // 并发下载每个包及其依赖
      const downloadPromises = parsedPackages.map(({ name, version }) =>
        downloadPackageAndDependencies(name, version)
      );

      await Promise.all(downloadPromises);

      // 生成日志内容
      const logContent = `
=== Downloaded Packages ===
${packageList.join('\n')}

=== Dependency Tree ===
${parsedPackages.map(({ name, version }) => buildDependencyTree(`${name}@${version}`)).join('\n')}

=== License Warnings ===
${licenseWarnings.length > 0 ? licenseWarnings.join('\n') : 'No license warnings.'}
`;

      // 写入日志文件
      fs.writeFileSync(LOG_FILE, logContent);

      console.log(chalk.green('All packages and dependencies downloaded successfully!'));
      console.log(chalk.green(`Log file saved to: ${LOG_FILE}`));

      // 输出许可证警告
      if (licenseWarnings.length > 0) {
        console.log(chalk.red('\n=== License Warnings ==='));
        licenseWarnings.forEach((warning) => console.log(chalk.red(warning)));
      }
    })
    .parse(process.argv);
}

main();
