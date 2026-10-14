**結論與總結**

`nvm` 查詢最新穩定版本（LTS）與最新版的指令主要依賴 `ls-remote` 搭配別名過濾。

* **查最新穩定版 (LTS)**：`nvm ls-remote --lts`
* **安裝最新穩定版 (LTS)**：`nvm install --lts`
* **查官方最新版 (Current)**：`nvm ls-remote node`
* **安裝官方最新版 (Current)**：`nvm install node`

---

### 1. 查詢版本 (遠端與本地)

* **列出所有官方釋出的 LTS 穩定版本**
```bash
nvm ls-remote --lts

```


* **快速查看「最新一個」LTS 版本號 (透過 tail 過濾)**
```bash
nvm ls-remote --lts | tail -n 1

```


* **查詢指定主要版本的最新 LTS（例：Node 20）**
```bash
nvm ls-remote "lts/*"
nvm ls-remote "v20*"

```


* **列出遠端所有可用版本**
```bash
nvm ls-remote

```


* **查看本機已安裝版本及當前生效版本**
```bash
nvm ls

```


* **僅查看當前 shell 作用中的版本號**
```bash
nvm current

```



---

### 2. 安裝與解除安裝

* **直接安裝最新穩定版 (LTS)**
```bash
nvm install --lts

```


* **安裝指定 LTS 代號（例：Iron, Hydrogen）**
```bash
nvm install lts/iron

```


* **直接安裝最新發行版 (Current)**
```bash
nvm install node

```


* **安裝指定版號**
```bash
nvm install 20.18.0

```


* **安裝新版並自動遷移舊版全域 npm 套件**
```bash
nvm install --lts --reinstall-packages-from=current

```


* **移除本機指定版本**
```bash
nvm uninstall 18.20.4

```



---

### 3. 切換版本與執行

* **切換至本機已安裝的最新 LTS 版本**
```bash
nvm use --lts

```


* **切換至特定版本**
```bash
nvm use 20

```


* **依據當前目錄 `.nvmrc` 自動切換**
```bash
nvm use

```


* **在指定版本環境下單次執行程式（不更改全域狀態）**
```bash
nvm exec 20.10.0 node server.js

```


* **在指定版本環境下執行 shell 指令**
```bash
nvm run 18.0.0 --version

```



---

### 4. 設定預設與別名 (Aliases)

* **將全域預設值固定為最新 LTS（重開終端機生效）**
```bash
nvm alias default 'lts/*'

```


* **將全域預設值固定為特定版本**
```bash
nvm alias default 20

```


* **建立自訂別名**
```bash
nvm alias my-api 20.11.0

```


* **刪除自訂別名**
```bash
nvm unalias my-api

```


* **退出 nvm 環境（還原系統原生 Node 路徑）**
```bash
nvm deactivate

```