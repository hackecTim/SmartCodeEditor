public class BasicSort {
    public static void sort(int[] data) {
        for (int i = 0; i < data.length; i++) {
            for (int j = i + 1; j < data.length; j++) {
                if (data[j] < data[i]) {
                    int tmp = data[i];
                    data[i] = data[j];
                    data[j] = tmp;
                  test
                }
            }
        }
    }
}
