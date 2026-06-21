# Azure Deployment Guide: 3D Urban Twin Pipeline

This guide provides step-by-step instructions to deploy the **3D Urban Twin** application (backend + frontend + database) to Azure with an automated GitHub Actions CI/CD pipeline, completely clean of "Manhattan" references.

---

## 🏗️ Phase 1: Deploying the Backend & Database (Azure App Service)

The Node.js backend handles OGC API Features requests and live WebSocket fleet movements. We host it on Azure App Service, where the SQLite GeoPackage database (`urban_twin.gpkg`) resides in persistent container storage.

### Step 1.1: Create the Azure App Service Web App
1. Log in to the [Azure Portal](https://portal.azure.com).
2. Click **Create a resource** and search for **Web App**.
3. Configure the following details:
   - **Subscription**: Choose your active Azure subscription.
   - **Resource Group**: Create a new one (e.g., `urban-twin-rg` or `3d-urban-twin-rg`).
   - **Name**: Pick a unique name (e.g., `3d-urban-twin-backend`). This forms your backend URL: `https://<your-backend-name>.azurewebsites.net`.
   - **Publish**: Select **Code**.
   - **Runtime stack**: Select **Node 20 LTS**.
   - **Operating System**: Select **Linux**.
   - **Pricing Plan**: Select **Basic B1** (B1 or higher is recommended for WebSocket support and reliable resource limits; Free F1 can be used but does not officially support production WebSockets).
4. Click **Review + Create**, then click **Create**. Wait for the resource deployment to complete.

> [!WARNING]
> **Quota / "Total VMs: 0" Error**:
> If you see an error saying *"Operation cannot be completed without additional quota. Current Limit (Total VMs): 0"*, this means your selected region does not have VM quota allocated for Linux/B1/F1 plans under your subscription.
>
> **How to fix this:**
> 1. **Use the Free F1 pricing tier**: When creating the Web App, go to the **Pricing Plan** (or App Service Plan) configuration, click **Explore pricing plans**, select the **Dev/Test** tab, and choose the **Free F1** tier. The Free F1 tier runs on shared infrastructure, which completely bypasses the VM quota limit check!
> 2. **Change the Region**: When creating the Web App, select a different **Region** (e.g., *East US*, *West US 3*, *North Europe*, or *Central US*).
> 3. **Switch to Windows**: Under **Operating System**, select **Windows** instead of Linux. Windows plans usually have higher pre-allocated quotas on new/free Azure accounts. The Node.js app runs perfectly on Windows App Service as well.

### Step 1.2: Enable WebSockets on Azure
Because the fleet moves in real-time, the backend uses WebSockets. By default, Azure disables WebSocket transport on Linux plans.
1. Go to your newly created **Web App** resource page on the Azure portal.
2. In the left menu under **Settings**, click on **Configuration** (or **Environment variables** depending on the portal version).
3. Select the **General settings** tab.
4. Locate the **WebSockets** toggle and switch it to **On**.
5. Click **Save** at the top.

### Step 1.3: Download the Publish Profile
To securely authorize GitHub Actions to deploy your backend without entering passwords, download the publish credentials:
1. On your Web App's **Overview** page, look at the top menu bar.
2. Click the **Get publish profile** button.
3. This downloads an XML file. Open it in a text editor (e.g., VS Code or Notepad) and copy the entire text content.

> [!IMPORTANT]
> **"Basic Authentication is disabled" Error**:
> Azure disables SCM Basic Authentication by default on new Web Apps for security. This will cause your GitHub Actions deployment workflow to fail.
> 
> **How to enable Basic Authentication for GitHub deployment:**
> 1. Go to your Web App resource page on the Azure portal.
> 2. In the left-hand menu, under **Settings**, click on **Configuration** (or **Configuration** -> **General settings** tab, or **Configuration** -> **Platform settings**).
>    - *Alternative location in new portals*: Go to **Deployment Center** in the left menu, select the **Settings** tab at the top.
> 3. Locate the setting named **SCM Basic Auth Publishing Credentials** (sometimes named **Basic Auth Publishing Credentials** or **SCM Basic Auth**).
> 4. Toggle this setting to **On** (or **Enabled**).
> 5. Click **Save** at the top (or click **Save** in the Deployment Center).
> 6. *Note: If you have a separate setting for **FTP Basic Auth Publishing Credentials**, you can leave it off; only SCM Basic Auth is required for GitHub Actions.*

---

## 📦 Phase 2: Configuring Backend GitHub Secrets & Triggering Deploy

Connect your GitHub repository to your Azure App Service.

### Step 2.1: Add Repository Secrets on GitHub
1. Go to your GitHub repository webpage.
2. Click the **Settings** tab.
3. Under the **Security** section in the left menu, select **Secrets and variables** -> **Actions**.
4. Click **New repository secret** and add the following two secrets:
   - **Secret 1**:
     - **Name**: `AZURE_WEBAPP_NAME`
     - **Value**: The exact name of your App Service (e.g., `3d-urban-twin-backend`).
   - **Secret 2**:
     - **Name**: `AZURE_WEBAPP_PUBLISH_PROFILE`
     - **Value**: Paste the complete XML content of the publish profile file you copied in Step 1.3.
5. Click **Add secret**.

### Step 2.2: Run the Deployment
* **Automatic trigger**: Push any changes to the main branch. The backend workflow `.github/workflows/deploy-backend.yml` triggers automatically because code changes are pushed under the `backend/` path.
* **Manual trigger**:
  1. Go to your GitHub repository -> click the **Actions** tab.
  2. Click **Deploy Backend to Azure App Service** in the left menu.
  3. Click the **Run workflow** dropdown on the right and select **Run workflow**.

---

## 🛠️ Phase 3: Seeding the GeoPackage Database on Azure

Because the database file `urban_twin.gpkg` is listed in your `.gitignore` and not committed to git, it will be missing on your first deployment. Run the seeder script directly inside your Azure Web App container:

1. In the Azure Portal, go to your **Web App** resource.
2. In the left menu under **Development Tools**, click on **SSH** (or search for "SSH" in the search bar).
3. Click the **Go ->** link. This opens a terminal inside the running Azure container.
4. Run the seed command to initialize the OGC GeoPackage database:
   ```bash
   cd /home/site/wwwroot && npm run seed
   ```
5. Confirm the console prints:
   ```text
   ✅ Done! Compliant urban_twin.gpkg created at /home/site/wwwroot/data/urban_twin.gpkg
      buildings: 416
      fleet:     20
      ndvi_grid: 168
   ```
6. Test your backend live endpoint by visiting: `https://<your-backend-name>.azurewebsites.net/health` (it should display `{"status":"ok","database":"healthy"}`).

---

## 🎨 Phase 4: Deploying the Frontend (Azure Static Web Apps)

Deploy the frontend React app to Azure Static Web Apps (which is free, scales automatically, and distributes files globally via a CDN).

### Step 4.1: Create the Static Web App
1. In the Azure Portal, search for **Static Web Apps**.
2. Click **Create** and configure:
   - **Subscription & Resource Group**: Select the same ones as before.
   - **Name**: Pick a name (e.g., `3d-urban-twin-frontend`).
   - **Plan type**: Select **Free** (covers all study needs).
   - **Deployment details**: Select **GitHub** and authorize your account.
   - **Repository details**: Select your repository name and select the `main` branch.
   - **Build Presets**: Select **Vite**.
   - **Build Details**:
     - **App location**: `/frontend`
     - **Api location**: *(leave empty)*
     - **Output location**: `dist`
3. Click **Review + Create**, then click **Create**.

### Step 4.2: Retrieve the Deployment Token
1. Go to your new Static Web App resource in the Azure portal.
2. On the **Overview** page, look at the top menu bar.
3. Click on the **Manage deployment token** button.
4. Copy the deployment token.

### Step 4.3: Configure Frontend GitHub Secrets
1. Go to your GitHub repository -> click **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret** and add the following:
   - **Secret name**: `AZURE_STATIC_WEB_APPS_API_TOKEN`
   - **Secret value**: Paste the deployment token you copied in Step 4.2.
3. Click **Add secret**.

---

## 🔗 Phase 5: Setting Up Environment Variables

To allow your compiled frontend to connect to the backend APIs and WebSocket streams:

1. In the GitHub Actions secrets page (**Settings** -> **Secrets and variables** -> **Actions**), add two more secrets that our build script requires:
   - **Secret 1**:
     - **Name**: `VITE_API_BASE_URL`
     - **Value**: `https://<your-backend-name>.azurewebsites.net` (no trailing slash)
   - **Secret 2**:
     - **Name**: `VITE_WS_BASE_URL`
     - **Value**: `wss://<your-backend-name>.azurewebsites.net` (uses secure WebSockets protocol)
2. Push a commit or trigger the **Deploy Frontend to Azure Static Web Apps** workflow manually from the Actions tab.
3. Once completed, your static site will be live at the auto-generated URL shown on the Static Web App's Overview page (e.g., `https://random-word-12345.azurestaticapps.net`).

You are now fully hosted on Azure with a complete, clean CI/CD automated pipeline!
