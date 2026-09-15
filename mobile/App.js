// Conduit on the phone: the web build (music.baxtergroup.io) inside a native
// WebView, so Expo Go runs it without a store build. The web app's mobile
// layout (bottom tabs, compact player) does the rest; this shell only
// supplies media playback permissions and a retry screen; it draws full-bleed
// and the page itself pads for the notch / home indicator (viewport-fit=cover).
import { useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';

const URL = process.env.EXPO_PUBLIC_CONDUIT_URL || 'https://music.baxtergroup.io/';

export default function App() {
  const web = useRef(null);
  const [error, setError] = useState(null);
  return (
    <View style={styles.root}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      {error ? (
        <View style={styles.err}>
          <Text style={styles.errText}>Conduit could not load{'\n'}{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => { setError(null); web.current?.reload(); }}><Text style={styles.btnText}>Retry</Text></TouchableOpacity>
        </View>
      ) : null}
      <WebView
        ref={web}
        source={{ uri: URL }}
        style={styles.web}
        // Audio keeps playing with the screen off; inline (no forced fullscreen video UI).
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        // The page runs its own edge-swipe-back (a navigation stack of its own);
        // the WebView's history gesture would swallow it and go nowhere.
        allowsBackForwardNavigationGestures={false}
        // The web app decides the layout; tell it it is inside the shell.
        applicationNameForUserAgent="ConduitMobile/0.1"
        // Full-bleed under the notch and home indicator; the page pads with env(safe-area-inset-*).
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Never leave the app for our own links; open anything else in the browser.
        setSupportMultipleWindows={false}
        pullToRefreshEnabled={Platform.OS === 'android'}
        onError={(e) => setError(e.nativeEvent.description || 'network error')}
        onHttpError={(e) => { if (e.nativeEvent.statusCode >= 500) setError(`HTTP ${e.nativeEvent.statusCode}`); }}
        backgroundColor="#000"
        overScrollMode="never"
        bounces={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  err: { position: 'absolute', zIndex: 2, top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', gap: 16 },
  errText: { color: '#b3b3b3', textAlign: 'center', fontSize: 15 },
  btn: { backgroundColor: '#1ed760', paddingHorizontal: 22, paddingVertical: 10, borderRadius: 500 },
  btnText: { color: '#000', fontWeight: '700' },
});
