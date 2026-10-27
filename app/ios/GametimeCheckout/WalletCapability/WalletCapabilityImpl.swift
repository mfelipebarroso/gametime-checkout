import Foundation
import PassKit

/// Apple Pay detection (SPEC §2). Called from the Objective-C++ Turbo Module glue.
@objc(WalletCapabilityImpl)
public final class WalletCapabilityImpl: NSObject {
  private static let networks: [PKPaymentNetwork] = [.visa, .masterCard, .amex, .discover]

  /// True only when the device can pay with a provisioned card on one of our networks.
  /// The argument-less `canMakePayments()` is not enough: it does not prove a card is provisioned.
  @objc public static func isApplePayAvailable() -> Bool {
    PKPaymentAuthorizationController.canMakePayments(usingNetworks: networks, capabilities: .threeDSecure)
  }
}
