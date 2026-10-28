#!/usr/bin/env python3
"""Deterministic Xcode project, standard plist only; no XcodeGen/Tuist dependency."""
from pathlib import Path
import hashlib, plistlib
from xml.sax.saxutils import escape
ROOT=Path(__file__).resolve().parents[1]
objects={}
def uid(name): return hashlib.sha1(name.encode()).hexdigest()[:24].upper()
def obj(key_name,isa,**fields):
    key=uid(key_name); objects[key]={'isa':isa,**fields}; return key
def ref(path,kind): return obj('file:'+path,'PBXFileReference',lastKnownFileType=kind,path=path,sourceTree='<group>')
def settings_list(name,settings):
    configs=[]
    for config in ['Debug','Release']:
        values=dict(settings)
        if config=='Debug': values.update({'SWIFT_OPTIMIZATION_LEVEL':'-Onone','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG $(inherited)','GCC_PREPROCESSOR_DEFINITIONS':['DEBUG=1','$(inherited)'],'ENABLE_TESTABILITY':'YES'})
        else: values.update({'SWIFT_COMPILATION_MODE':'wholemodule','SWIFT_OPTIMIZATION_LEVEL':'-O'})
        configs.append(obj(name+config,'XCBuildConfiguration',name=config,buildSettings=values))
    return obj(name+'configs','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
app_swift=sorted(p.relative_to(ROOT).as_posix() for p in (ROOT/'Claudex').rglob('*.swift'))
test_swift=sorted(p.relative_to(ROOT).as_posix() for p in (ROOT/'ClaudexTests').glob('*.swift'))
ui_swift=sorted(p.relative_to(ROOT).as_posix() for p in (ROOT/'ClaudexUITests').glob('*.swift'))
file_refs={p:ref(p,'sourcecode.swift') for p in app_swift+test_swift+ui_swift}
asset='Claudex/Resources/Assets.xcassets'; asset_ref=ref(asset,'folder.assetcatalog')
privacy='Claudex/Resources/PrivacyInfo.xcprivacy'; privacy_ref=ref(privacy,'text.xml')
shared='Claudex/Resources/SharedConversation'; shared_ref=ref(shared,'folder')
# String catalogues (en + zh-Hans, read by StringCatalog) and the bundled open fonts.
strings_ref=ref('Claudex/Resources/Strings','folder'); fonts_ref=ref('Claudex/Resources/Fonts','folder')
fixtures_ref=ref('ClaudexTests/Fixtures','folder')
product_app=obj('product:app','PBXFileReference',explicitFileType='wrapper.application',path='Claudex.app',sourceTree='BUILT_PRODUCTS_DIR',includeInIndex=0)
product_test=obj('product:test','PBXFileReference',explicitFileType='wrapper.cfbundle',path='ClaudexTests.xctest',sourceTree='BUILT_PRODUCTS_DIR',includeInIndex=0)
product_ui=obj('product:ui','PBXFileReference',explicitFileType='wrapper.cfbundle',path='ClaudexUITests.xctest',sourceTree='BUILT_PRODUCTS_DIR',includeInIndex=0)
def phase(name,isa,refs): return obj(name,isa,buildActionMask=2147483647,files=[obj(name+str(i),'PBXBuildFile',fileRef=r) for i,r in enumerate(refs)],runOnlyForDeploymentPostprocessing=0)
verify_phase=obj('verify-shared-renderer','PBXShellScriptBuildPhase',name='Verify shared conversation bundle',buildActionMask=2147483647,files=[],inputPaths=['$(SRCROOT)/scripts/verify_shared_conversation_bundle.py','$(SRCROOT)/shared-conversation-lock.json','$(SRCROOT)/Claudex/Resources/SharedConversation'] + ['$(SRCROOT)/' + p.relative_to(ROOT).as_posix() for p in sorted((ROOT/'Claudex/Resources/SharedConversation').rglob('*'))],outputPaths=[],runOnlyForDeploymentPostprocessing=0,shellPath='/bin/sh',shellScript='set -eu\n/usr/bin/python3 "$SRCROOT/scripts/verify_shared_conversation_bundle.py"\n',alwaysOutOfDate=1)
project_id=uid('project'); app_id=uid('app')
proxy=obj('test-proxy','PBXContainerItemProxy',containerPortal=project_id,proxyType=1,remoteGlobalIDString=app_id,remoteInfo='Claudex')
dep=obj('test-dependency','PBXTargetDependency',target=app_id,targetProxy=proxy)
common={'SDKROOT':'iphoneos','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SWIFT_VERSION':'5.0','TARGETED_DEVICE_FAMILY':'1,2','CLANG_ENABLE_MODULES':'YES','SWIFT_STRICT_CONCURRENCY':'complete','CODE_SIGN_STYLE':'Automatic','DEVELOPMENT_TEAM':'','VERSIONING_SYSTEM':'apple-generic','CURRENT_PROJECT_VERSION':'1','MARKETING_VERSION':'0.5.0','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO','ENABLE_USER_SCRIPT_SANDBOXING':'YES'}
app_settings={**common,'PRODUCT_BUNDLE_IDENTIFIER':'com.example.claudex','PRODUCT_NAME':'$(TARGET_NAME)','INFOPLIST_FILE':'Claudex/Resources/Info.plist','GENERATE_INFOPLIST_FILE':'NO','ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon','ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME':'AccentColor','CLAUDEX_SERVICE_URL':'https://claudex.example.com','LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks']}
app=obj('app','PBXNativeTarget',name='Claudex',productName='Claudex',productType='com.apple.product-type.application',productReference=product_app,buildConfigurationList=settings_list('app',app_settings),buildPhases=[verify_phase,phase('app-sources','PBXSourcesBuildPhase',[file_refs[p] for p in app_swift]),phase('app-resources','PBXResourcesBuildPhase',[asset_ref,privacy_ref,shared_ref,strings_ref,fonts_ref]),phase('app-frameworks','PBXFrameworksBuildPhase',[])],buildRules=[],dependencies=[])
test_settings={**common,'PRODUCT_BUNDLE_IDENTIFIER':'com.example.claudex.tests','PRODUCT_NAME':'$(TARGET_NAME)','GENERATE_INFOPLIST_FILE':'YES','BUNDLE_LOADER':'$(TEST_HOST)','TEST_HOST':'$(BUILT_PRODUCTS_DIR)/Claudex.app/Claudex','LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks','@loader_path/Frameworks']}
test=obj('tests','PBXNativeTarget',name='ClaudexTests',productName='ClaudexTests',productType='com.apple.product-type.bundle.unit-test',productReference=product_test,buildConfigurationList=settings_list('tests',test_settings),buildPhases=[phase('test-sources','PBXSourcesBuildPhase',[file_refs[p] for p in test_swift]),phase('test-resources','PBXResourcesBuildPhase',[fixtures_ref]),phase('test-frameworks','PBXFrameworksBuildPhase',[])],buildRules=[],dependencies=[dep])
ui_settings={**common,'PRODUCT_BUNDLE_IDENTIFIER':'com.example.claudex.uitests','PRODUCT_NAME':'$(TARGET_NAME)','GENERATE_INFOPLIST_FILE':'YES','TEST_TARGET_NAME':'Claudex'}
ui=obj('ui','PBXNativeTarget',name='ClaudexUITests',productName='ClaudexUITests',productType='com.apple.product-type.bundle.ui-testing',productReference=product_ui,buildConfigurationList=settings_list('ui',ui_settings),buildPhases=[phase('ui-sources','PBXSourcesBuildPhase',[file_refs[p] for p in ui_swift]),phase('ui-frameworks','PBXFrameworksBuildPhase',[])],buildRules=[],dependencies=[dep])
products=obj('products','PBXGroup',children=[product_app,product_test,product_ui],name='Products',sourceTree='<group>')
source_group=obj('source-group','PBXGroup',children=[file_refs[p] for p in app_swift]+[asset_ref,privacy_ref,shared_ref,strings_ref,fonts_ref,ref('Claudex/Resources/Info.plist','text.plist.xml')],name='Claudex',sourceTree='<group>')
test_group=obj('test-group','PBXGroup',children=[file_refs[p] for p in test_swift+ui_swift]+[fixtures_ref],name='Tests',sourceTree='<group>')
main=obj('main','PBXGroup',children=[source_group,test_group,products],sourceTree='<group>')
obj('project','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2600','TargetAttributes':{app:{'CreatedOnToolsVersion':'26.0'},test:{'CreatedOnToolsVersion':'26.0','TestTargetID':app},ui:{'CreatedOnToolsVersion':'26.0','TestTargetID':app}}},buildConfigurationList=settings_list('project',{'ALWAYS_SEARCH_USER_PATHS':'NO','CLANG_ENABLE_OBJC_ARC':'YES','CLANG_WARN_DOCUMENTATION_COMMENTS':'YES','GCC_C_LANGUAGE_STANDARD':'gnu17','DEBUG_INFORMATION_FORMAT':'dwarf-with-dsym'}),compatibilityVersion='Xcode 14.0',developmentRegion='zh-Hans',knownRegions=['zh-Hans','en','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',targets=[app,test,ui])
project=ROOT/'Claudex.xcodeproj';project.mkdir(exist_ok=True)
with (project/'project.pbxproj').open('wb') as f: plistlib.dump({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':objects,'rootObject':project_id},f,sort_keys=False)
def buildable(target,name): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:Claudex.xcodeproj"/>'
scheme=f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.7"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildable(app,'Claudex.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{buildable(test,'ClaudexTests.xctest')}</TestableReference><TestableReference skipped="NO">{buildable(ui,'ClaudexUITests.xctest')}</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildable(app,'Claudex.app')}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildable(app,'Claudex.app')}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>'''
p=project/'xcshareddata/xcschemes';p.mkdir(parents=True,exist_ok=True);(p/'Claudex.xcscheme').write_text(scheme)
print(f'Generated {project.name}: {len(app_swift)} app files, {len(test_swift)} unit-test files, {len(ui_swift)} UI-test files')

