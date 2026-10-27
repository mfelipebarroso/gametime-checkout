#import "RCTWalletCapability.h"
// The generated Swift header also declares SceneDelegate, whose superclass lives here.
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import "GametimeCheckout-Swift.h"

@implementation RCTWalletCapability

+ (NSString *)moduleName
{
  return @"WalletCapability";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeWalletCapabilitySpecJSI>(params);
}

- (void)isApplePayAvailable:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve(@([WalletCapabilityImpl isApplePayAvailable]));
}

// Google Pay does not exist on iOS.
- (void)isGooglePayReady:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve(@NO);
}

@end
