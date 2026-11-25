package com.claudex.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Reads one fix for a location tool and keeps it on this device.
 * The coordinates are not shown, stored, or sent. A disabled service or a missing
 * permission returns no position.
 */
internal object DeviceLocation {
    fun take(context: Context, requested: String): String? {
        val manager = context.getSystemService(LocationManager::class.java) ?: return "off"
        val servicesOn = if (Build.VERSION.SDK_INT >= 28) manager.isLocationEnabled else runCatching { manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) }.getOrDefault(false)
        val granted = when {
            allowed(context, Manifest.permission.ACCESS_FINE_LOCATION) -> "precise"
            allowed(context, Manifest.permission.ACCESS_COARSE_LOCATION) -> "coarse"
            else -> null
        }
        DeviceAccess.locationGate(servicesOn, granted)?.let { return it }
        val provider = if (granted == "precise") LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
        val fix = runCatching { manager.getLastKnownLocation(provider) ?: manager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) }.getOrNull() ?: return "waiting"
        val revealed = DeviceAccess.reveal(requested, granted ?: return "denied", fix.latitude, fix.longitude) ?: return "waiting"
        return if (revealed.first.isFinite() && revealed.second.isFinite()) null else "waiting"
    }

    private fun allowed(context: Context, permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
