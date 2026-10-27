package com.gametimecheckout.wallet

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.wallet.IsReadyToPayRequest
import com.google.android.gms.wallet.Wallet
import com.google.android.gms.wallet.WalletConstants

/** Google Pay readiness via PaymentsClient.isReadyToPay (SPEC §2). */
class WalletCapabilityModule(reactContext: ReactApplicationContext) : NativeWalletCapabilitySpec(reactContext) {

  override fun getName(): String = NAME

  // Apple Pay does not exist on Android.
  override fun isApplePayAvailable(promise: Promise) {
    promise.resolve(false)
  }

  override fun isGooglePayReady(promise: Promise) {
    try {
      val client =
        Wallet.getPaymentsClient(
          reactApplicationContext,
          Wallet.WalletOptions.Builder().setEnvironment(WalletConstants.ENVIRONMENT_TEST).build(),
        )
      client.isReadyToPay(IsReadyToPayRequest.fromJson(IS_READY_TO_PAY_JSON)).addOnCompleteListener { task ->
        try {
          val ready = task.getResult(ApiException::class.java) == true
          Log.i(TAG, "isReadyToPay result=$ready")
          promise.resolve(ready)
        } catch (e: ApiException) {
          // Any failure only hides the wallet; it never blocks checkout.
          Log.i(TAG, "isReadyToPay failed statusCode=${e.statusCode}")
          promise.resolve(false)
        } catch (e: Exception) {
          Log.i(TAG, "isReadyToPay failed ${e.javaClass.simpleName}")
          promise.resolve(false)
        }
      }
    } catch (e: Exception) {
      Log.i(TAG, "PaymentsClient unavailable ${e.javaClass.simpleName}")
      promise.resolve(false)
    }
  }

  companion object {
    const val NAME = "WalletCapability"
    private const val TAG = "WalletCapability"

    private val IS_READY_TO_PAY_JSON =
      """
      {
        "apiVersion": 2,
        "apiVersionMinor": 0,
        "allowedPaymentMethods": [{
          "type": "CARD",
          "parameters": {
            "allowedAuthMethods": ["PAN_ONLY", "CRYPTOGRAM_3DS"],
            "allowedCardNetworks": ["AMEX", "DISCOVER", "MASTERCARD", "VISA"]
          }
        }],
        "existingPaymentMethodRequired": true
      }
      """.trimIndent()
  }
}
