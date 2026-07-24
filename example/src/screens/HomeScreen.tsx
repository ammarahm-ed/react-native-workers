import {
  Text,
  View,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
} from 'react-native';
import { SCREENS, type ScreenId } from './index';

export default function HomeScreen({
  onOpen,
}: {
  onOpen: (id: ScreenId) => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.blurb}>
        Web Worker-style APIs backed by real Hermes runtimes. Pick something to
        run — {Platform.OS === 'ios' ? 'iOS' : 'Android'}.
      </Text>
      <ScrollView style={styles.list}>
        {SCREENS.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => onOpen(s.id)}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
          >
            <Text style={styles.cardTitle}>{s.title}</Text>
            <Text style={styles.cardBlurb}>{s.blurb}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  blurb: { fontSize: 14, color: '#555', marginBottom: 14, lineHeight: 20 },
  list: { flex: 1 },
  card: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    backgroundColor: '#fafafa',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  pressed: { backgroundColor: '#eeeeee' },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardBlurb: { fontSize: 13, color: '#666', marginTop: 3 },
});
