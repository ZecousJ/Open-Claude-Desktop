import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "com.claudex.mobile"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.claudex.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 9
        versionName = "0.8.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "SERVER_ORIGIN", "\"${providers.gradleProperty("claudexOrigin").getOrElse("https://claudex.example.com")}\"")
    }
    // Release signing: the keystore and its passwords live
    // outside the repository; pass them as gradle properties (~/.gradle/gradle.properties
    // or -P). Without them the release build is left unsigned.
    val releaseStore = providers.gradleProperty("claudexReleaseStoreFile").orNull
    signingConfigs {
        if (releaseStore != null) create("release") {
            storeFile = file(releaseStore)
            storePassword = providers.gradleProperty("claudexReleaseStorePassword").get()
            keyAlias = providers.gradleProperty("claudexReleaseKeyAlias").get()
            keyPassword = providers.gradleProperty("claudexReleaseKeyPassword").get()
        }
    }
    buildTypes {
        getByName("release") { if (releaseStore != null) signingConfig = signingConfigs.getByName("release") }
    }
    flavorDimensions += "backend"
    productFlavors {
        create("demo") { dimension = "backend"; applicationIdSuffix = ".demo"; resValue("string", "app_name", "Claudex Demo"); buildConfigField("boolean", "DEMO_MODE", "true") }
        create("production") { dimension = "backend"; resValue("string", "app_name", "Claudex"); buildConfigField("boolean", "DEMO_MODE", "false") }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
dependencies {
    implementation(project(":core"))
    testImplementation(kotlin("test-junit"))
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3:1.4.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.9")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.10.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.5.0")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}


// Generated once from the canonical shared-source commit. A native checkout builds without a sibling web tree.
// Refresh with scripts/import-shared-conversation.py, never hand-edit bundled HTML/JS/CSS.
val verifySharedConversation by tasks.registering {
    val bundle = layout.projectDirectory.dir("src/main/assets/conversation")
    val lockFile = rootProject.layout.projectDirectory.file("shared-conversation-lock.json")
    inputs.dir(bundle)
    inputs.file(lockFile)
    doLast {
        fun digest(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        val folder = bundle.asFile
        val manifestFile = folder.resolve("reuse-manifest.json")
        require(lockFile.asFile.isFile && manifestFile.isFile) { "Canonical shared conversation bundle missing. Run scripts/import-shared-conversation.py with the pinned source revision and manifest hash." }
        val parser = groovy.json.JsonSlurper()
        val lock = parser.parse(lockFile.asFile) as Map<*, *>
        val manifest = parser.parse(manifestFile) as Map<*, *>
        require(lock["version"] == 1 && lock["protocol"] == 1 && manifest["protocol"] == 1 && manifest["version"] == 1 && manifest["entry"] == "index.html") { "Unsupported shared conversation protocol" }
        require(lock["sourceRevision"] == manifest["sourceRevision"] && (lock["sourceRevision"] as? String)?.matches(Regex("[0-9a-f]{40}")) == true) { "Shared conversation source revision mismatch" }
        require(digest(manifestFile) == lock["manifestSha256"]) { "Shared conversation manifest was modified or is stale" }
        val assets = manifest["assets"] as? List<*> ?: error("Missing shared asset inventory")
        require(assets.isNotEmpty() && assets.size < 1024)
        val declared = assets.map { value ->
            val row = value as Map<*, *>
            val name = row["file"] as String
            require(name == "index.html" || name.startsWith("assets/")) { "Unexpected shared asset path" }
            require(!name.contains("..") && !name.contains('\\') && !name.endsWith(".map")) { "Unsafe shared asset path" }
            val file = folder.resolve(name)
            require(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.canonicalPath.startsWith(folder.canonicalPath + File.separator)) { "Shared asset missing: $name" }
            require(file.length() == (row["bytes"] as Number).toLong() && digest(file) == row["sha256"]) { "Shared asset does not match canonical build: $name" }
            name
        }.toSet()
        val installed = folder.walkTopDown().filter { it.isFile }.map { it.relativeTo(folder).invariantSeparatorsPath }.toSet() - "reuse-manifest.json"
        require(installed == declared && "index.html" in declared) { "Shared bundle includes missing or untracked files" }
    }
}
tasks.named("preBuild").configure { dependsOn(verifySharedConversation) }
