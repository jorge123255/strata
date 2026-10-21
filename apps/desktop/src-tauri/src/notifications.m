// Runs inside Strata's existing executable. No helper app or second notification identity.
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

typedef void (*StrataNotificationClick)(const char *);
static StrataNotificationClick clicked;

@interface StrataNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation StrataNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    UNNotificationPresentationOptions options = UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList;
    if (notification.request.content.sound) options |= UNNotificationPresentationOptionSound;
    completionHandler(options);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completionHandler {
    // A banner only opens a conversation. It never approves a tool or sends a message.
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier] && clicked) {
        NSDictionary *destination = response.notification.request.content.userInfo[@"destination"];
        if ([destination isKindOfClass:NSDictionary.class]) {
            NSData *data = [NSJSONSerialization dataWithJSONObject:destination options:0 error:nil];
            NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
            if (json) clicked(json.UTF8String);
        }
    }
    completionHandler();
}
@end

static StrataNotificationDelegate *delegate;
static BOOL sessionActive = YES;
static id sessionActiveObserver, sessionResignObserver;
static char *strata_result(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
    return strdup(json.UTF8String);
}

void strata_notifications_init(StrataNotificationClick callback) {
    clicked = callback;
    delegate = [StrataNotificationDelegate new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = delegate;
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    sessionActiveObserver = [workspace addObserverForName:NSWorkspaceSessionDidBecomeActiveNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { sessionActive = YES; }];
    sessionResignObserver = [workspace addObserverForName:NSWorkspaceSessionDidResignActiveNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { sessionActive = NO; }];
}

bool strata_notifications_focused(void) {
    __block BOOL focused = NO;
    void (^check)(void) = ^{ focused = sessionActive && NSApp.active && NSApp.keyWindow.visible && !NSApp.keyWindow.miniaturized; };
    if (NSThread.isMainThread) check(); else dispatch_sync(dispatch_get_main_queue(), check);
    return focused;
}

// These three calls run only on the shell's private HTTP worker, never the main thread.
char *strata_notifications_status(void) {
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block NSString *authorization = @"unavailable";
    [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        switch (settings.authorizationStatus) {
            case UNAuthorizationStatusNotDetermined: authorization = @"not-determined"; break;
            case UNAuthorizationStatusDenied: authorization = @"denied"; break;
            case UNAuthorizationStatusAuthorized: case UNAuthorizationStatusProvisional: authorization = @"authorized"; break;
            default: break;
        }
        dispatch_semaphore_signal(completed);
    }];
    BOOL finished = dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
    if (!finished) return strata_result(@{@"available": @NO, @"authorization": @"unavailable", @"detail": @"macOS notification settings did not respond. Try again."});
    return strata_result(@{@"available": @YES, @"authorization": authorization, @"detail": @"Strata uses macOS Notification Center while the app is running."});
}

char *strata_notifications_permission(void) {
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block BOOL allowed = NO;
    [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
        allowed = granted && !error; dispatch_semaphore_signal(completed);
    }];
    BOOL finished = dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)) == 0;
    if (!finished) return strata_result(@{@"available": @YES, @"authorization": @"not-determined", @"detail": @"Finish the macOS permission request, then refresh notification settings."});
    return strata_result(@{@"available": @YES, @"authorization": allowed ? @"authorized" : @"denied", @"detail": allowed ? @"Notifications are allowed for Strata." : @"Allow Strata in System Settings → Notifications to receive banners."});
}

char *strata_notifications_deliver(const char *json) {
    @autoreleasepool {
        NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = value[@"title"]; content.body = value[@"body"];
        content.userInfo = @{@"destination": value[@"destination"]};
        content.threadIdentifier = [NSString stringWithFormat:@"%@:%@", value[@"destination"][@"type"], value[@"destination"][@"id"]];
        if ([value[@"sound"] boolValue]) content.sound = UNNotificationSound.defaultSound;
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:value[@"id"] content:content trigger:nil];
        dispatch_semaphore_t completed = dispatch_semaphore_create(0); __block BOOL delivered = NO;
        [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) { delivered = !error; dispatch_semaphore_signal(completed); }];
        BOOL finished = dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
        return strata_result(@{@"delivered": @(finished && delivered)});
    }
}

void strata_notifications_free(char *value) { free(value); }
