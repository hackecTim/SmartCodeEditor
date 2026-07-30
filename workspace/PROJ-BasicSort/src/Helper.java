public class Helper {
    public static void printArray(int[] data) {
        for (int value : data) {
            System.out.println(value);
        }
    }

    public static boolean isSorted(int[] data) {
        for (int i = 1; i < data.length; i++) {
            if (data[i - 1] > data[i]) return false;
        }
        return true;
    }
}
