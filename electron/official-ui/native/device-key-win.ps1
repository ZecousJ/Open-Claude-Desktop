param(
    [string]$Operation,
    [string]$StatePath
)

$ErrorActionPreference = 'Stop'

function Get-DevicePublicKey([System.Security.Cryptography.CngKey]$Key) {
    $blob = $Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    if ($blob.Length -ne 72 -or [BitConverter]::ToUInt32($blob, 0) -ne 0x31534345 -or [BitConverter]::ToUInt32($blob, 4) -ne 32) {
        throw 'The TPM key is not an ECDSA P-256 key.'
    }

    # DER SubjectPublicKeyInfo for id-ecPublicKey, prime256v1, and an uncompressed point.
    $prefix = [Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE')
    $spki = New-Object byte[] 91
    [Array]::Copy($prefix, $spki, $prefix.Length)
    [Array]::Copy($blob, 8, $spki, $prefix.Length, 64)
    return [Convert]::ToBase64String($spki)
}

$key = $null
$signer = $null
try {
    if ($Operation -notin @('public', 'sign', 'rotate')) {
        throw 'Expected public, sign, or rotate.'
    }

    $keyId = $null
    try {
        $keyId = [IO.File]::ReadAllText($StatePath)
        if ($keyId -cnotmatch '\A[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}\z') {
            throw 'The device key state is invalid.'
        }
    } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
        if ($Operation -eq 'sign') { throw 'The device key has not been created.' }
    }

    $provider = [System.Security.Cryptography.CngProvider]::new('Microsoft Platform Crypto Provider')
    $openOptions = [System.Security.Cryptography.CngKeyOpenOptions]::Silent
    $keyNamePrefix = 'Claudex.OfficialDeviceKey.'
    if ($keyId -and $Operation -ne 'rotate') {
        $key = [System.Security.Cryptography.CngKey]::Open($keyNamePrefix + $keyId, $provider, $openOptions)
        if ($Operation -eq 'public') {
            [Console]::Out.WriteLine((Get-DevicePublicKey $key))
        } else {
            $inputLine = [Console]::In.ReadLine()
            if ($null -eq $inputLine) { throw 'Expected a base64 preimage on stdin.' }
            $preimage = [Convert]::FromBase64String($inputLine)
            $signer = [System.Security.Cryptography.ECDsaCng]::new($key)
            $signer.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
            [Console]::Out.WriteLine([Convert]::ToBase64String($signer.SignData($preimage)))
        }
        return
    }

    $nextId = [Guid]::NewGuid().ToString('N')
    $parameters = [System.Security.Cryptography.CngKeyCreationParameters]::new()
    $parameters.Provider = $provider
    $parameters.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
    $parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
    $key = [System.Security.Cryptography.CngKey]::Create(
        [System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $keyNamePrefix + $nextId, $parameters)

    $temporaryPath = "$StatePath.$nextId.tmp"
    try {
        $publicKey = Get-DevicePublicKey $key
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StatePath))
        [IO.File]::WriteAllText($temporaryPath, $nextId)
        if ($keyId) {
            [IO.File]::Replace($temporaryPath, $StatePath, [NullString]::Value)
        } else {
            [IO.File]::Move($temporaryPath, $StatePath)
        }
    } catch {
        $key.Delete()
        [IO.File]::Delete($temporaryPath)
        throw
    }

    if ($keyId) {
        $previous = $null
        try {
            $previous = [System.Security.Cryptography.CngKey]::Open($keyNamePrefix + $keyId, $provider, $openOptions)
            $previous.Delete()
        } catch {
            $errorCause = $_.Exception.GetBaseException()
            if ($errorCause.HResult -notin @(0x80090011, 0x80090016)) {
                [Console]::Error.WriteLine("Could not delete the previous TPM key. $($errorCause.Message)")
            }
        } finally {
            if ($previous) { $previous.Dispose() }
        }
    }

    [Console]::Out.WriteLine($publicKey)
} catch {
    $errorCause = $_.Exception.GetBaseException()
    [Console]::Error.WriteLine($errorCause.Message)
    # NTE_DEVICE_NOT_READY, NTE_DEVICE_NOT_FOUND, TBS_E_TPM_NOT_FOUND, TPM_E_PCP_DEVICE_NOT_READY.
    if ($errorCause.HResult -in @(0x80090030, 0x80090035, 0x8028400F, 0x80290401)) { exit 2 }
    exit 3
} finally {
    if ($signer) { $signer.Dispose() }
    if ($key) { $key.Dispose() }
}
