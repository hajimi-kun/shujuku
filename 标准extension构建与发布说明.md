# 标准 extension 构建与直装发布完整说明

这份文档描述的是**当前这套仓库的标准发布链**，目标是：

1. 从源码仓库构建出标准插件产物 `dist/extension`
2. 再把产物发布到直装仓库 `niccolecantdoit-rgb/shujuku-extension-only`
3. 让 SillyTavern 通过仓库地址直接安装

> 适用环境：**Windows PowerShell**

---

## 一、两套仓库分别是什么

### 1. 源码仓库

当前工作目录示例：

```powershell
C:\Users\EDY\Desktop\【项目代码】\数据库\shujuku-plus-rebuild-69b3173
```

这个仓库负责：

- 存放源码
- 执行测试
- 运行标准 extension 构建
- 产出 `dist/extension/index.js`

### 2. 直装仓库

仓库地址：

```text
https://github.com/niccolecantdoit-rgb/shujuku-extension-only
```

默认分支：

```text
extension-only
```

这个仓库只负责**给 SillyTavern 直接安装**，根目录长期只保留：

- `index.js`
- `manifest.json`

SillyTavern 通过仓库地址安装时，会直接读取：

1. 默认分支根目录的 `manifest.json`
2. `manifest.json` 里的 `js: "index.js"`
3. 根目录的 `index.js`

所以，**直装仓库不能直接放源码结构**，必须放打包好的标准 extension 产物。

---

## 二、标准 extension 发布链到底是哪条

当前标准链是：

- 入口文件：`src/entry-extension.ts`
- 构建配置：`rollup.config.js`
- 输出目录：`dist/extension`
- 清单文件：仓库根目录 `manifest.json`

### 产物结果

构建完成后，必须得到：

```text
dist/extension/index.js
dist/extension/manifest.json
```

其中 `dist/extension/manifest.json` 的内容来自根目录 `manifest.json` 的复制结果。

---

## 三、构建前一定要确认的事

在源码仓库根目录先检查：

```powershell
git status --short --branch
```

这个命令的意义：

- 看当前在哪个分支
- 看有没有未提交改动
- 确认你知道这次构建是不是来自“工作树 dirty 状态”

如果你只想打包，不想提交源码，允许工作树 dirty。  
如果你想要严格可追溯版本，应该先把源码提交，再构建。

再确认当前提交 SHA：

```powershell
git rev-parse HEAD
```

这个 SHA 会作为发布记录里的来源基准。

---

## 四、标准 extension 构建步骤

### 第 1 步：进入源码仓库

```powershell
Set-Location "C:\Users\EDY\Desktop\【项目代码】\数据库\shujuku-plus-rebuild-69b3173"
```

### 第 2 步：执行标准 extension 构建

```powershell
$env:BUILD_MODE='extension'
npx rollup -c
```

说明：

- 这里是 **PowerShell 写法**
- 不要写成 Unix 风格的：

```powershell
BUILD_MODE=extension npx rollup -c
```

在 Windows PowerShell 里这样写通常不生效。

### 第 3 步：确认构建成功

成功时会看到类似输出：

```text
src/entry-extension.ts → dist/extension/index.js...
created dist/extension/index.js in 3.8s
```

### 第 4 步：检查输出目录

```powershell
Get-ChildItem .\dist\extension
```

应至少看到：

```text
index.js
manifest.json
```

### 第 5 步：确认 manifest 正常

```powershell
Get-Content .\dist\extension\manifest.json
```

你至少要确认：

```json
{
  "display_name": "星·数据库 III",
  "js": "index.js"
}
```

---

## 五、建议的构建后检查

虽然不是每次强制，但建议至少做下面这些：

### 类型检查

```powershell
npm run typecheck
```

### 测试

```powershell
npm test
```

### 检查产物里是否真的带了你本轮改动

比如搜关键标记：

```powershell
Select-String -Path ".\dist\extension\index.js" -Pattern "acu-vis-assistant-btn","openVisualizer","template-preset-ui"
```

如果你刚改的是别的功能，就替换成相应关键字。

---

## 六、发布到直装仓库的原理

发布动作本质上不是“推源码”，而是：

1. 克隆直装仓库 `extension-only` 分支到临时目录
2. 把源码仓库的：
   - `dist/extension/index.js`
   - `dist/extension/manifest.json`
   覆盖到直装仓库根目录的：
   - `index.js`
   - `manifest.json`
3. 如果有差异，就 commit + push

也就是说：

- **源码仓库**负责生产产物
- **直装仓库**只负责承载产物

---

## 七、手动发布的完整 PowerShell 步骤

下面是最完整的手动发布流程。

### 第 1 步：准备变量

```powershell
$SourceSha = git rev-parse HEAD
$SrcRepo = "C:\Users\EDY\Desktop\【项目代码】\数据库\shujuku-plus-rebuild-69b3173"
$PublishDir = Join-Path $env:TEMP 'shujuku-extension-only-publish-manual'
```

### 第 2 步：清理旧临时目录

```powershell
if (Test-Path $PublishDir) {
    Remove-Item -Recurse -Force $PublishDir
}
```

### 第 3 步：克隆直装仓库的 `extension-only` 分支

```powershell
git clone --branch extension-only --single-branch https://github.com/niccolecantdoit-rgb/shujuku-extension-only.git $PublishDir
```

如果 GitHub 直连失败，再走代理：

```powershell
$env:HTTP_PROXY='http://127.0.0.1:7897'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:ALL_PROXY='socks5://127.0.0.1:7897'

git clone --branch extension-only --single-branch https://github.com/niccolecantdoit-rgb/shujuku-extension-only.git $PublishDir
```

### 第 4 步：覆盖产物文件

```powershell
Copy-Item "$SrcRepo\dist\extension\index.js" "$PublishDir\index.js" -Force
Copy-Item "$SrcRepo\dist\extension\manifest.json" "$PublishDir\manifest.json" -Force
```

### 第 5 步：看这次是否真的有变化

```powershell
git -C $PublishDir diff -- index.js manifest.json
```

如果这里没有任何 diff，说明这次发布其实是 **no-op**，就没必要再提交。

也可以用静默判断：

```powershell
git -C $PublishDir diff --quiet -- index.js manifest.json
if ($LASTEXITCODE -eq 0) {
    Write-Host 'NO_CHANGES_TO_PUBLISH'
}
```

### 第 6 步：提交直装仓库

```powershell
git -C $PublishDir add index.js manifest.json

git -C $PublishDir `
  -c user.name="Niccole" `
  -c user.email="234573773+niccolecantdoit-rgb@users.noreply.github.com" `
  commit -m "build: refresh extension-only from ${SourceSha}-dirty" `
  -m "Source-Ref: standard dist/extension from working-tree over $SourceSha" `
  -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-opencode)" `
  -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

> 说明：这里使用的是**临时提交身份**，不会修改全局 git config。

### 第 7 步：推送到远端

```powershell
git -C $PublishDir push origin extension-only
```

如果直连失败，再走代理重试：

```powershell
$env:HTTP_PROXY='http://127.0.0.1:7897'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:ALL_PROXY='socks5://127.0.0.1:7897'

git -C $PublishDir push origin extension-only
```

### 第 8 步：查看最后一条提交

```powershell
git -C $PublishDir log -1 --oneline
```

---

## 八、发布后的远端验证

### 1）验证最新提交

```powershell
gh api repos/niccolecantdoit-rgb/shujuku-extension-only/commits/extension-only
```

重点看：

- `sha`
- `commit.message`

### 2）验证仓库根目录只剩两个文件

```powershell
gh api repos/niccolecantdoit-rgb/shujuku-extension-only/contents?ref=extension-only
```

正常情况下应该只有：

- `index.js`
- `manifest.json`

### 3）验证直装仓库地址

```text
https://github.com/niccolecantdoit-rgb/shujuku-extension-only
```

---

## 九、为什么我一直强调“标准 extension”，不是自定义产物

之前有过一套自定义链：

- `entry-extension-plus-assistantembedded.ts`
- `rollup.plus-assistantembedded.config.js`
- `manifest.plus-assistantembedded.json`

那套东西会产出自定义目录，比如：

```text
dist/plus-assistantembedded
```

但现在正确的标准发布链已经统一成：

```text
src/entry-extension.ts
-> rollup.config.js
-> dist/extension/index.js
-> 发布到直装仓库根目录 index.js
```

所以以后发布**只认 `dist/extension`**。

---

## 十、推荐的一键发布脚本思路

如果你以后想自己封装一个 PowerShell 脚本，建议流程固定为：

1. `git rev-parse HEAD`
2. `$env:BUILD_MODE='extension'; npx rollup -c`
3. clone `extension-only`
4. copy `dist/extension/index.js`
5. copy `dist/extension/manifest.json`
6. `git diff --quiet`
7. `git add`
8. `git commit`
9. `git push`
10. `gh api` 验证

---

## 十一、最常见的坑

### 1. 在 PowerShell 里写 Unix 风格环境变量

错误写法：

```powershell
BUILD_MODE=extension npx rollup -c
```

正确写法：

```powershell
$env:BUILD_MODE='extension'
npx rollup -c
```

### 2. 误把源码仓库根目录直接拿去给 SillyTavern 装

SillyTavern 仓库直装读的是仓库根目录：

- `manifest.json`
- `index.js`

所以必须走直装仓库，而不是直接把源码仓库 URL 丢给它。

### 3. 以为“推源码分支”就等于“更新直装仓库”

不是。  
源码分支更新 ≠ 直装仓库更新。

直装仓库必须单独做一次产物覆盖发布。

### 4. 看到 `export` 报错

在这个 Windows PowerShell 环境里，前缀：

```powershell
export CI=true ...
```

会报错，因为 `export` 不是 PowerShell 命令。  
以后如果只是本地执行，直接省掉它；或者改成 PowerShell 的 `$env:` 形式。

---

## 十二、最短可执行版本

如果你只想要一个极简手册，最短就是这几步：

```powershell
# 1. 进入源码仓库
Set-Location "C:\Users\EDY\Desktop\【项目代码】\数据库\shujuku-plus-rebuild-69b3173"

# 2. 构建标准 extension
$env:BUILD_MODE='extension'
npx rollup -c

# 3. 准备临时发布目录
$SourceSha = git rev-parse HEAD
$SrcRepo = (Get-Location).Path
$PublishDir = Join-Path $env:TEMP 'shujuku-extension-only-publish-manual'
if (Test-Path $PublishDir) { Remove-Item -Recurse -Force $PublishDir }

# 4. 克隆直装仓库
git clone --branch extension-only --single-branch https://github.com/niccolecantdoit-rgb/shujuku-extension-only.git $PublishDir

# 5. 覆盖产物
Copy-Item "$SrcRepo\dist\extension\index.js" "$PublishDir\index.js" -Force
Copy-Item "$SrcRepo\dist\extension\manifest.json" "$PublishDir\manifest.json" -Force

# 6. 提交并推送
git -C $PublishDir add index.js manifest.json
git -C $PublishDir -c user.name="Niccole" -c user.email="234573773+niccolecantdoit-rgb@users.noreply.github.com" commit -m "build: refresh extension-only from ${SourceSha}-dirty" -m "Source-Ref: standard dist/extension from working-tree over $SourceSha"
git -C $PublishDir push origin extension-only
```

---

## 十三、当前这份文档的用途

以后你每次让我“打包”“推一下”“再来一次”，我做的本质上就是这条链：

**源码仓库当前工作树 → 标准 `dist/extension` → 直装仓库根目录**

如果以后你要把这份文档再升级成：

- 一键 PowerShell 脚本
- 带代理自动重试版
- 同时提交源码仓库 + 发布直装仓库版

可以在这个文档基础上继续扩展。
