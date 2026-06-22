package sort;

public class Main {
    public static void main(String[] args) {
        int[] data = {5, 3, 1, 4, 2};
        BasicSort.bubbleSort(data);
        for (int x : data) System.out.print(x + " ");
        
    }
}
